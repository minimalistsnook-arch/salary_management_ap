import { applyToLedger, buildLedger, type Ledger } from '../../../src/domain/allocation';
import type { BulkActionRequest, BulkActionResult, TransactionRow } from '../../../src/domain/dto';
import { feeWarning, largeDepositWarning } from '../../../src/domain/feeCheck';
import { similarity } from '../../../src/domain/matching';
import { isYearMonth } from '../../../src/domain/month';
import type { Client, YearMonth } from '../../../src/domain/types';
import { auditStmt } from '../../audit';
import { AppError, nowIso, placeholders, type SqlDb, type SqlStatement } from '../../db';
import { allocationsForClients, listClients, queryTransactions } from '../../repos';
import { learnAliasStmt } from '../clientMatching/matchingService';
import { insertAllocationStmts, planForClient, upsertMatchStmt } from './allocationService';

const MAX_IDS = 300;

async function loadTransactions(db: SqlDb, ids: number[]): Promise<TransactionRow[]> {
  const out: TransactionRow[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    out.push(...(await queryTransactions(db, `t.id IN (${placeholders(chunk.length)})`, chunk)));
  }
  return out;
}

/**
 * 거래 일괄 처리 (거래처 입출금내역정리의 V 선택).
 * - confirm : 추천 거래처(또는 지정 거래처)로 확정. 첫 적용월은 관리 시작월/기존 기록이 없는 거래처에만 사용
 * - redate  : 선택 거래의 배정을 지우고 입력한 월 이후 가장 오래된 미납월부터 다시 배정
 * - unassign: 확정·배정 취소 (추천 거래처는 남겨 다시 확정 가능)
 * 필요한 데이터는 한 번에 읽고, 계산 후 하나의 원자적 batch 로 저장한다.
 */
export async function bulkTransactions(db: SqlDb, req: BulkActionRequest): Promise<BulkActionResult> {
  const ids = [...new Set((req?.ids ?? []).filter((n) => Number.isSafeInteger(n) && n > 0))];
  if (!ids.length) throw new AppError('선택한 거래가 없습니다.');
  if (ids.length > MAX_IDS) throw new AppError(`한 번에 ${MAX_IDS}건까지 처리할 수 있습니다.`);
  if (!['confirm', 'redate', 'unassign'].includes(req.action)) throw new AppError('알 수 없는 작업입니다.');
  if (req.startMonth && !isYearMonth(req.startMonth)) throw new AppError('첫 적용월은 YYYY-MM 형식이어야 합니다.');
  if (req.action === 'redate' && !req.startMonth) throw new AppError('변경할 적용월을 입력해주세요.');

  const txs = await loadTransactions(db, ids);
  const result: BulkActionResult = { done: 0, skipped: [], failed: [] };
  const stmts: SqlStatement[] = [];

  if (req.action === 'unassign') {
    for (const t of txs) {
      if (t.match_status !== 'AUTO_MATCHED' && t.match_status !== 'MANUAL_MATCHED') {
        result.skipped.push({ id: t.id, reason: '확정된 거래가 아님' });
        continue;
      }
      stmts.push(
        db.prepare('DELETE FROM payment_allocations WHERE transaction_id = ?').bind(t.id),
        upsertMatchStmt(db, t.id, { clientId: t.client_id, score: t.similarity_score, matchType: t.match_type, status: 'REVIEW_REQUIRED', note: t.note }),
        auditStmt(db, 'BULK_UNASSIGN', 'transaction', t.id, { client_id: t.client_id, status: t.match_status, allocations: t.allocations }, { status: 'REVIEW_REQUIRED' }),
      );
      result.done++;
    }
    if (stmts.length) await db.batch(stmts);
    return result;
  }

  const clients = new Map<number, Client>((await listClients(db)).map((c) => [c.id, c]));
  const targets: { t: TransactionRow; client: Client }[] = [];
  for (const t of txs) {
    const confirmed = t.match_status === 'AUTO_MATCHED' || t.match_status === 'MANUAL_MATCHED';
    if (t.deposit_amount <= 0) {
      result.skipped.push({ id: t.id, reason: '출금 거래' });
      continue;
    }
    if (req.action === 'confirm' && confirmed && t.allocations.length && req.clientId == null) {
      result.skipped.push({ id: t.id, reason: '이미 확정됨' });
      continue;
    }
    const clientId = req.clientId ?? t.client_id;
    const client = clientId != null ? clients.get(clientId) : undefined;
    if (!client) {
      result.failed.push({ id: t.id, error: '추천 거래처가 없습니다. 거래처를 지정해주세요.' });
      continue;
    }
    if (!client.active) {
      result.failed.push({ id: t.id, error: `비활성 거래처입니다: ${client.name}` });
      continue;
    }
    if (req.action === 'confirm' && !req.includeWarnings) {
      const warn = feeWarning(t.deposit_amount, client.current_contract_amount) ?? largeDepositWarning(t.deposit_amount, client.current_contract_amount);
      if (warn) {
        result.skipped.push({ id: t.id, reason: `경고: ${warn}` });
        continue;
      }
    }
    targets.push({ t, client });
  }

  // 대상 거래의 기존 배정은 제외하고 원장 구성 → 거래일시 순으로 누적 배정
  const targetIds = new Set(targets.map((x) => x.t.id));
  const clientIds = [...new Set(targets.map((x) => x.client.id))];
  const allocs = (await allocationsForClients(db, clientIds)).filter((a) => a.transaction_id == null || !targetIds.has(a.transaction_id));
  const ledgers = new Map<number, Ledger>(clientIds.map((id) => [id, buildLedger(allocs.filter((a) => a.client_id === id))]));
  const startMonths = new Map<number, YearMonth | null>(clientIds.map((id) => [id, clients.get(id)?.management_start_month ?? null]));
  const now = nowIso();

  targets.sort((a, b) => a.t.transaction_datetime.localeCompare(b.t.transaction_datetime) || a.t.id - b.t.id);
  for (const { t, client } of targets) {
    const ledger = ledgers.get(client.id) as Ledger;
    const currentStart = startMonths.get(client.id) ?? null;
    let override: YearMonth | undefined;
    if (req.action === 'redate') override = req.startMonth ?? undefined;
    else if (!currentStart && ledger.size === 0) {
      if (!req.startMonth) {
        result.failed.push({ id: t.id, error: `월 배정 필요 — ${client.name}: 첫 적용월을 입력해주세요.` });
        continue;
      }
      override = req.startMonth;
    }
    const plan = planForClient({ ...client, management_start_month: currentStart }, ledger, t.deposit_amount, override);
    if (!plan.lines.length) {
      result.failed.push({ id: t.id, error: plan.error ?? '배정할 수 없습니다.' });
      continue;
    }
    applyToLedger(ledger, plan.lines);
    if (!currentStart && override) {
      startMonths.set(client.id, override);
      stmts.push(
        db.prepare('UPDATE clients SET management_start_month = ?, updated_at = ? WHERE id = ? AND management_start_month IS NULL').bind(override, now, client.id),
        auditStmt(db, 'SET_START_MONTH', 'client', client.id, { management_start_month: null }, { management_start_month: override, reason: 'BULK' }),
      );
    }
    stmts.push(
      db.prepare('DELETE FROM payment_allocations WHERE transaction_id = ?').bind(t.id),
      upsertMatchStmt(db, t.id, { clientId: client.id, score: similarity(t.sender_raw, client.name), matchType: 'MANUAL', status: 'MANUAL_MATCHED', note: t.note }),
      ...insertAllocationStmts(db, { idSql: '?', idParams: [t.id] }, client.id, t.transaction_datetime.slice(0, 10), plan.lines, 'BANK'),
      auditStmt(
        db,
        req.action === 'redate' ? 'BULK_REDATE' : 'BULK_CONFIRM',
        'transaction',
        t.id,
        { client_id: t.client_id, status: t.match_status, allocations: t.allocations },
        { client_id: client.id, client_name: client.name, start_month: override ?? null, allocations: plan.lines },
      ),
    );
    const alias = learnAliasStmt(db, t.sender_raw, client.id);
    if (alias) stmts.push(alias);
    result.done++;
  }
  if (stmts.length) await db.batch(stmts);
  return result;
}
