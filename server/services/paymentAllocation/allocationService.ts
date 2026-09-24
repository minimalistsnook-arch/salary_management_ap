import { allocatePayment, buildLedger, monthStatus, resolveStartMonth, type AllocationLine, type Ledger } from '../../../src/domain/allocation';
import { similarity } from '../../../src/domain/matching';
import { assertWon } from '../../../src/domain/money';
import { isYearMonth } from '../../../src/domain/month';
import type { AllocationSource, Client, YearMonth } from '../../../src/domain/types';
import { auditStmt } from '../../audit';
import { AppError, all, first, nowIso, type SqlDb, type SqlStatement } from '../../db';
import { allocationsForClients, getClient } from '../../repos';
import { learnAliasStmt } from '../clientMatching/matchingService';

export interface PlanResult {
  startMonth: YearMonth | null;
  lines: AllocationLine[];
  unallocated: number;
  needsStartMonth: boolean;
  error: string | null;
}

/** 거래처 1곳에 대한 월분 배정 계획 (DB 미반영) */
export function planForClient(client: Client, ledger: Ledger, amount: number, startOverride?: YearMonth | null): PlanResult {
  const startMonth = resolveStartMonth({ overrideMonth: startOverride, managementStartMonth: client.management_start_month, ledger });
  if (!startMonth) {
    return { startMonth: null, lines: [], unallocated: amount, needsStartMonth: true, error: '월 배정 필요 — 기존 기록이 없어 첫 적용월을 선택해야 합니다.' };
  }
  if (client.current_contract_amount <= 0) {
    return { startMonth, lines: [], unallocated: amount, needsStartMonth: false, error: '월 계약금액이 0원이라 자동 배정할 수 없습니다.' };
  }
  const r = allocatePayment({ amount, contractAmount: client.current_contract_amount, startMonth, ledger });
  return { startMonth, lines: r.lines, unallocated: r.unallocated, needsStartMonth: false, error: r.unallocated > 0 ? `${r.unallocated.toLocaleString('ko-KR')}원을 배정하지 못했습니다.` : null };
}

export async function loadLedger(db: SqlDb, clientId: number, excludeTransactionId?: number): Promise<Ledger> {
  return buildLedger(await allocationsForClients(db, [clientId], excludeTransactionId));
}

/** 배정 INSERT. transactionIdSql 은 '?' 또는 서브쿼리 */
export function insertAllocationStmts(
  db: SqlDb,
  tx: { idSql: string; idParams: unknown[] },
  clientId: number,
  paymentDate: string,
  lines: { serviceMonth: YearMonth; amount: number; contractSnapshot: number; status: string }[],
  source: AllocationSource,
): SqlStatement[] {
  const now = nowIso();
  return lines.map((l) =>
    db
      .prepare(
        `INSERT INTO payment_allocations (transaction_id, client_id, service_month, payment_date, allocated_amount, contract_amount_snapshot, status, source, created_at)
         VALUES ((${tx.idSql}), ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(...tx.idParams, clientId, l.serviceMonth, paymentDate, l.amount, l.contractSnapshot, l.status, source, now),
  );
}

// ---------------- 저장 이후 사용자 수정 ----------------

interface BankTxRow {
  id: number;
  transaction_datetime: string;
  sender_raw: string;
  deposit_amount: number;
  withdrawal_amount: number;
}
interface MatchRow {
  client_id: number | null;
  similarity_score: number;
  match_type: string;
  status: string;
  note: string | null;
}

async function loadTx(db: SqlDb, txId: number) {
  const tx = await first<BankTxRow>(db, 'SELECT id, transaction_datetime, sender_raw, deposit_amount, withdrawal_amount FROM bank_transactions WHERE id = ?', txId);
  if (!tx) throw new AppError('거래를 찾을 수 없습니다.', 404);
  const match = await first<MatchRow>(db, 'SELECT client_id, similarity_score, match_type, status, note FROM transaction_client_matches WHERE transaction_id = ?', txId);
  const allocations = await all<Record<string, unknown>>(db, 'SELECT * FROM payment_allocations WHERE transaction_id = ? ORDER BY service_month', txId);
  return { tx, match, allocations };
}

export function upsertMatchStmt(db: SqlDb, txId: number, m: { clientId: number | null; score: number; matchType: string; status: string; note: string | null }) {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO transaction_client_matches (transaction_id, client_id, similarity_score, match_type, status, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(transaction_id) DO UPDATE SET client_id = excluded.client_id, similarity_score = excluded.similarity_score,
         match_type = excluded.match_type, status = excluded.status, note = excluded.note, updated_at = excluded.updated_at`,
    )
    .bind(txId, m.clientId, m.score, m.matchType, m.status, m.note, now, now);
}

/** 거래처 지정/변경 (+ 첫 적용월 지정). 기존 배정은 지우고 가장 오래된 미납월부터 다시 배정 */
export async function assignTransaction(db: SqlDb, txId: number, input: { clientId: number; startMonth?: YearMonth | null; note?: string | null; learnAlias?: boolean }) {
  const { tx, match, allocations } = await loadTx(db, txId);
  const client = await getClient(db, input.clientId);
  if (!client) throw new AppError('거래처를 찾을 수 없습니다.');
  if (input.startMonth && !isYearMonth(input.startMonth)) throw new AppError('첫 적용월은 YYYY-MM 형식이어야 합니다.');

  let lines: AllocationLine[] = [];
  if (tx.deposit_amount > 0) {
    const ledger = await loadLedger(db, client.id, txId);
    const plan = planForClient(client, ledger, tx.deposit_amount, input.startMonth);
    if (plan.needsStartMonth) throw new AppError(plan.error ?? '월 배정 필요', 409, { code: 'NEEDS_START_MONTH' });
    if (plan.error && !plan.lines.length) throw new AppError(plan.error);
    lines = plan.lines;
  }
  const note = input.note === undefined ? (match?.note ?? null) : input.note;
  const after = { client_id: client.id, client_name: client.name, status: 'MANUAL_MATCHED', start_month: input.startMonth ?? null, note, allocations: lines };
  const stmts: SqlStatement[] = [
    db.prepare('DELETE FROM payment_allocations WHERE transaction_id = ?').bind(txId),
    upsertMatchStmt(db, txId, { clientId: client.id, score: similarity(tx.sender_raw, client.name), matchType: 'MANUAL', status: 'MANUAL_MATCHED', note }),
    ...insertAllocationStmts(db, { idSql: '?', idParams: [txId] }, client.id, tx.transaction_datetime.slice(0, 10), lines, 'BANK'),
    auditStmt(db, 'ASSIGN_CLIENT', 'transaction', txId, { match, allocations }, after),
  ];
  if (input.startMonth && !client.management_start_month) {
    stmts.push(db.prepare('UPDATE clients SET management_start_month = ?, updated_at = ? WHERE id = ?').bind(input.startMonth, nowIso(), client.id));
    stmts.push(auditStmt(db, 'SET_START_MONTH', 'client', client.id, { management_start_month: null }, { management_start_month: input.startMonth }));
  }
  if (input.learnAlias !== false) {
    const alias = learnAliasStmt(db, tx.sender_raw, client.id);
    if (alias) stmts.push(alias);
  }
  await db.batch(stmts);
  return after;
}

/** 배정 수동 수정 (적용월 / 배정금액) */
export async function setManualAllocations(db: SqlDb, txId: number, input: { lines: { serviceMonth: YearMonth; amount: number }[]; note?: string | null }) {
  const { tx, match, allocations } = await loadTx(db, txId);
  if (!match?.client_id || (match.status !== 'AUTO_MATCHED' && match.status !== 'MANUAL_MATCHED')) {
    throw new AppError('먼저 거래처를 확정해야 배정을 수정할 수 있습니다.');
  }
  const client = await getClient(db, match.client_id);
  if (!client) throw new AppError('거래처를 찾을 수 없습니다.');
  const seen = new Set<string>();
  let sum = 0;
  for (const l of input.lines) {
    if (!isYearMonth(l.serviceMonth)) throw new AppError(`적용월 형식이 잘못되었습니다: ${l.serviceMonth}`);
    if (seen.has(l.serviceMonth)) throw new AppError(`같은 적용월이 중복되었습니다: ${l.serviceMonth}`);
    seen.add(l.serviceMonth);
    try {
      assertWon(l.amount, '배정금액');
    } catch (e) {
      throw new AppError((e as Error).message);
    }
    if (l.amount <= 0) throw new AppError('배정금액은 0보다 커야 합니다.');
    sum += l.amount;
  }
  if (sum > tx.deposit_amount) {
    throw new AppError(`배정금액 합계(${sum.toLocaleString('ko-KR')}원)가 입금액(${tx.deposit_amount.toLocaleString('ko-KR')}원)을 초과합니다.`);
  }
  const ledger = await loadLedger(db, client.id, txId);
  const lines = [...input.lines]
    .sort((a, b) => (a.serviceMonth < b.serviceMonth ? -1 : 1))
    .map((l) => {
      const e = ledger.get(l.serviceMonth);
      const snapshot = e ? e.snapshot : client.current_contract_amount;
      return { serviceMonth: l.serviceMonth, amount: l.amount, contractSnapshot: snapshot, status: monthStatus((e?.paid ?? 0) + l.amount, snapshot) };
    });
  const note = input.note === undefined ? match.note : input.note;
  const stmts: SqlStatement[] = [
    db.prepare('DELETE FROM payment_allocations WHERE transaction_id = ?').bind(txId),
    ...insertAllocationStmts(db, { idSql: '?', idParams: [txId] }, client.id, tx.transaction_datetime.slice(0, 10), lines, 'MANUAL'),
    db.prepare('UPDATE transaction_client_matches SET note = ?, updated_at = ? WHERE transaction_id = ?').bind(note, nowIso(), txId),
    auditStmt(db, 'EDIT_ALLOCATIONS', 'transaction', txId, { allocations, note: match.note }, { allocations: lines, note, unallocated: tx.deposit_amount - sum }),
  ];
  await db.batch(stmts);
  return { lines, unallocated: tx.deposit_amount - sum };
}

/** 거래처 배정 취소 → 확인필요 상태로 되돌림 */
export async function unassignTransaction(db: SqlDb, txId: number) {
  const { match, allocations } = await loadTx(db, txId);
  await db.batch([
    db.prepare('DELETE FROM payment_allocations WHERE transaction_id = ?').bind(txId),
    upsertMatchStmt(db, txId, { clientId: null, score: 0, matchType: 'NONE', status: 'REVIEW_REQUIRED', note: match?.note ?? null }),
    auditStmt(db, 'UNASSIGN_CLIENT', 'transaction', txId, { match, allocations }, { status: 'REVIEW_REQUIRED' }),
  ]);
}

export async function updateNote(db: SqlDb, txId: number, note: string | null) {
  const { match } = await loadTx(db, txId);
  await db.batch([
    upsertMatchStmt(db, txId, {
      clientId: match?.client_id ?? null,
      score: match?.similarity_score ?? 0,
      matchType: match?.match_type ?? 'NONE',
      status: match?.status ?? 'UNMATCHED',
      note,
    }),
    auditStmt(db, 'EDIT_NOTE', 'transaction', txId, { note: match?.note ?? null }, { note }),
  ]);
}
