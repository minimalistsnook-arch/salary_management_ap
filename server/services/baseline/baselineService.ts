import { allocatePayment, applyToLedger, monthStatus, type Ledger } from '../../../src/domain/allocation';
import { parseBaselineTable, type BaselineRow } from '../../../src/domain/baselineTable';
import type { BaselineApplyResult, BaselinePreviewResponse, BaselinePreviewRow } from '../../../src/domain/dto';
import { feeWarning, largeDepositWarning } from '../../../src/domain/feeCheck';
import { similarity } from '../../../src/domain/matching';
import { addMonths, compareMonths } from '../../../src/domain/month';
import { normalizeName } from '../../../src/domain/normalize';
import type { Client, YearMonth } from '../../../src/domain/types';
import { auditStmt } from '../../audit';
import { AppError, nowIso, type SqlDb, type SqlStatement } from '../../db';
import { listClients, queryTransactions } from '../../repos';
import { loadMatchIndex, matchWithIndex } from '../clientMatching/matchingService';
import { insertAllocationStmts, upsertMatchStmt } from '../paymentAllocation/allocationService';

/**
 * 회원사별 '마지막 입금' 기준표 반영.
 * - 통장 입금 중 기준 입금일과 같은 날 입금이 있으면: 그 입금 = 기준 월분, 이전 입금은 거꾸로(전월들) 배정
 * - 없으면(CMS 묶음 입금 등): 기준 월분·입금일을 기존 기록(BASELINE)으로 저장
 * - 기준 입금일 이후 통장 입금은 다음 월분부터 순서대로 배정
 * - 관리 시작월 = 배정된 가장 이른 월, 계약형태·입금예상일·담당·연번 저장
 * 같은 기준표를 다시 적용해도 결과가 같다 (기존 BASELINE 기록은 지우고 다시 작성).
 */

interface Plan {
  row: BaselineRow;
  preview: BaselinePreviewRow;
  client: Client | null;
  txLines: Map<number, { serviceMonth: YearMonth; amount: number }[]>;
}

function backwardFill(amount: number, contract: number, cursor: YearMonth): { lines: { serviceMonth: YearMonth; amount: number }[]; cursor: YearMonth } {
  const lines: { serviceMonth: YearMonth; amount: number }[] = [];
  let left = amount;
  let m = cursor;
  while (left > 0) {
    const take = Math.min(contract, left);
    lines.unshift({ serviceMonth: m, amount: take });
    left -= take;
    m = addMonths(m, -1);
  }
  return { lines, cursor: m };
}

async function buildPlans(db: SqlDb, text: string, reference: string) {
  const parsed = parseBaselineTable(text, reference);
  const clients = await listClients(db);
  const byNorm = new Map<string, Client>();
  for (const c of clients) if (!byNorm.has(normalizeName(c.name)) || c.active) byNorm.set(normalizeName(c.name), c);
  const index = await loadMatchIndex(db);
  const txs = (await queryTransactions(db, 't.deposit_amount > 0')).filter((t) => t.client_id != null && t.match_status !== 'UNMATCHED');

  const plans: Plan[] = parsed.rows.map((row) => {
    let client = byNorm.get(normalizeName(row.name)) ?? null;
    if (!client) {
      const m = matchWithIndex(row.name, index);
      if (m.status === 'AUTO_MATCHED' && m.clientId != null) client = clients.find((c) => c.id === m.clientId) ?? null;
    }
    const preview: BaselinePreviewRow = {
      line: row.line,
      seq: row.seq,
      name: row.name,
      clientId: client?.id ?? null,
      clientName: client?.name ?? null,
      lastMonth: row.lastMonth,
      lastDate: row.lastDate,
      mode: !client ? 'NO_CLIENT' : !row.lastMonth ? 'NO_RECORD' : 'BASELINE',
      baselineRecord: null,
      deposits: [],
      startMonth: null,
      warnings: [],
    };
    const txLines = new Map<number, { serviceMonth: YearMonth; amount: number }[]>();
    if (!client || !row.lastMonth || !row.lastDate) return { row, preview, client, txLines };

    const contract = row.contractAmount && row.contractAmount > 0 ? row.contractAmount : client.current_contract_amount;
    if (row.contractAmount && row.contractAmount !== client.current_contract_amount) {
      preview.warnings.push(`계약금액이 거래처 시트(${client.current_contract_amount.toLocaleString('ko-KR')})와 다릅니다 → 기준표 금액으로 배정`);
    }
    // 확정된 입금은 모두 포함. 추천 상태 입금은 경고(큰 금액·수수료 차감)가 없는 것만 포함하고, 경고 건은 개별건에 남긴다
    const isConfirmed = (t: { match_status: string }) => t.match_status === 'AUTO_MATCHED' || t.match_status === 'MANUAL_MATCHED';
    const mine = txs.filter((t) => t.client_id === client!.id);
    const skippedWarn = mine.filter((t) => !isConfirmed(t) && (feeWarning(t.deposit_amount, contract) || largeDepositWarning(t.deposit_amount, contract)));
    for (const t of skippedWarn) {
      preview.warnings.push(`${t.transaction_datetime.slice(5, 10)} ${t.deposit_amount.toLocaleString('ko-KR')}원 추천 입금은 경고 건이라 제외 (개별건 유지)`);
    }
    const deposits = mine
      .filter((t) => !skippedWarn.includes(t))
      .sort((a, b) => a.transaction_datetime.localeCompare(b.transaction_datetime) || a.id - b.id);
    const lastDate = row.lastDate;
    const before = deposits.filter((d) => d.transaction_datetime.slice(0, 10) <= lastDate);
    const after = deposits.filter((d) => d.transaction_datetime.slice(0, 10) > lastDate);
    const ledger: Ledger = new Map();

    let cursor: YearMonth = row.lastMonth;
    const anchor = before.some((d) => d.transaction_datetime.slice(0, 10) === lastDate);
    if (!anchor) {
      preview.baselineRecord = { month: row.lastMonth, date: lastDate, amount: contract };
      applyToLedger(ledger, [{ serviceMonth: row.lastMonth, amount: contract, contractSnapshot: contract }]);
      cursor = addMonths(row.lastMonth, -1);
    }
    // 기준일 이전(포함) 입금: 가장 최근 입금부터 거꾸로
    for (const d of [...before].reverse()) {
      const r = backwardFill(d.deposit_amount, contract, cursor);
      cursor = r.cursor;
      txLines.set(d.id, r.lines);
      applyToLedger(ledger, r.lines.map((l) => ({ ...l, contractSnapshot: contract })));
    }
    // 기준일 이후 입금: 다음 월분부터
    for (const d of after) {
      const r = allocatePayment({ amount: d.deposit_amount, contractAmount: contract, startMonth: addMonths(row.lastMonth, 1), ledger });
      txLines.set(d.id, r.lines.map((l) => ({ serviceMonth: l.serviceMonth, amount: l.amount })));
      applyToLedger(ledger, r.lines);
    }
    for (const d of deposits) {
      const lines = txLines.get(d.id) ?? [];
      preview.deposits.push({
        id: d.id,
        date: d.transaction_datetime.slice(0, 10),
        sender: d.sender_raw,
        amount: d.deposit_amount,
        wasConfirmed: d.match_status === 'AUTO_MATCHED' || d.match_status === 'MANUAL_MATCHED',
        before: d.allocations.map((a) => a.service_month),
        after: lines.map((l) => l.serviceMonth),
      });
      if (d.deposit_amount % contract !== 0) preview.warnings.push(`${d.transaction_datetime.slice(5, 10)} 입금 ${d.deposit_amount.toLocaleString('ko-KR')}원은 계약금액 배수가 아닙니다 (부분납 발생)`);
    }
    if (deposits.some((d) => d.match_status === 'REVIEW_REQUIRED')) preview.warnings.push('추천 상태 입금을 이 거래처로 확정합니다');
    const months = [...ledger.keys()].sort(compareMonths);
    preview.startMonth = months[0] ?? row.lastMonth;
    return { row, preview, client, txLines };
  });
  return { parsed, plans, contractOf: (p: Plan) => (p.row.contractAmount && p.row.contractAmount > 0 ? p.row.contractAmount : (p.client?.current_contract_amount ?? 0)) };
}

export async function previewBaseline(db: SqlDb, input: { text: string; reference?: string }): Promise<BaselinePreviewResponse> {
  if (!input?.text?.trim()) throw new AppError('기준표 내용을 붙여넣어 주세요.');
  const reference = input.reference ?? nowIso().slice(0, 10);
  const { parsed, plans } = await buildPlans(db, input.text, reference);
  const dup = new Map<number, number>();
  for (const p of plans) if (p.client) dup.set(p.client.id, (dup.get(p.client.id) ?? 0) + 1);
  for (const p of plans) if (p.client && (dup.get(p.client.id) ?? 0) > 1) p.preview.warnings.push('다른 행과 같은 거래처로 연결되었습니다 — 적용에서 제외');
  return { reference, errors: parsed.errors, rows: plans.map((p) => p.preview) };
}

export async function applyBaseline(db: SqlDb, input: { text: string; reference?: string }): Promise<BaselineApplyResult> {
  const preview = await previewBaseline(db, input);
  if (preview.errors.length) throw new AppError('기준표에 읽을 수 없는 행이 있습니다.', 400, preview.errors);
  const { plans, contractOf } = await buildPlans(db, input.text, preview.reference);
  const excluded = new Set(preview.rows.filter((r) => r.warnings.some((w) => w.includes('적용에서 제외'))).map((r) => r.line));
  const now = nowIso();
  const stmts: SqlStatement[] = [];
  const result: BaselineApplyResult = { clients: 0, baselineRecords: 0, deposits: 0, allocations: 0, metaOnly: 0, skipped: 0 };

  for (const p of plans) {
    if (!p.client || excluded.has(p.row.line)) {
      result.skipped++;
      continue;
    }
    const c = p.client;
    const r = p.row;
    // 부가 정보 (계약형태·입금예상일·담당·연번)
    stmts.push(
      db
        .prepare(
          `UPDATE clients SET contract_type = COALESCE(?, contract_type), expected_pay_day = COALESCE(?, expected_pay_day), manager = COALESCE(?, manager),
             legacy_seq = COALESCE(?, legacy_seq), updated_at = ? WHERE id = ?`,
        )
        .bind(r.contractType, r.expectedPayDay, r.manager, r.seq, now, c.id),
    );
    if (p.preview.mode !== 'BASELINE' || !r.lastMonth || !r.lastDate) {
      result.metaOnly++;
      continue;
    }
    const contract = contractOf(p);
    result.clients++;
    // 이전 기준표 기록 제거 후 다시 작성
    stmts.push(db.prepare("DELETE FROM payment_allocations WHERE client_id = ? AND source = 'LEGACY' AND legacy_key LIKE 'B|%'").bind(c.id));
    if (p.preview.baselineRecord) {
      const b = p.preview.baselineRecord;
      stmts.push(
        db
          .prepare(
            `INSERT INTO payment_allocations (transaction_id, client_id, service_month, payment_date, allocated_amount, contract_amount_snapshot, status, source, legacy_key, created_at)
             VALUES (NULL, ?, ?, ?, ?, ?, 'PAID', 'LEGACY', ?, ?)`,
          )
          .bind(c.id, b.month, b.date, b.amount, contract, `B|${c.id}|${b.month}|${b.date}`, now),
      );
      result.baselineRecords++;
    }
    // 통장 입금 재배정 (월 상태 계산용 누적)
    const paid = new Map<YearMonth, number>();
    if (p.preview.baselineRecord) paid.set(p.preview.baselineRecord.month, contract);
    const ordered = [...p.preview.deposits].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    for (const d of ordered) {
      const lines = (p.txLines.get(d.id) ?? []).map((l) => {
        const after = (paid.get(l.serviceMonth) ?? 0) + l.amount;
        paid.set(l.serviceMonth, after);
        return { serviceMonth: l.serviceMonth, amount: l.amount, contractSnapshot: contract, status: monthStatus(after, contract) };
      });
      stmts.push(
        db.prepare('DELETE FROM payment_allocations WHERE transaction_id = ?').bind(d.id),
        upsertMatchStmt(db, d.id, { clientId: c.id, score: similarity(d.sender, c.name), matchType: 'MANUAL', status: 'MANUAL_MATCHED', note: null }),
        ...insertAllocationStmts(db, { idSql: '?', idParams: [d.id] }, c.id, d.date, lines, 'BANK'),
        auditStmt(db, 'BASELINE_ALIGN', 'transaction', d.id, { allocations: d.before }, { client_id: c.id, allocations: lines }),
      );
      result.deposits++;
      result.allocations += lines.length;
    }
    stmts.push(
      db.prepare('UPDATE clients SET management_start_month = ?, updated_at = ? WHERE id = ?').bind(p.preview.startMonth, now, c.id),
      auditStmt(db, 'APPLY_BASELINE', 'client', c.id, { management_start_month: c.management_start_month }, { last_month: r.lastMonth, last_date: r.lastDate, start_month: p.preview.startMonth }),
    );
  }
  if (stmts.length) await db.batch(stmts);
  return result;
}
