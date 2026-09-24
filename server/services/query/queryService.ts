import { outstandingMonths, type GridAllocation } from '../../../src/domain/advisoryGrid';
import type { AdvisoryResponse, AuditLog, DashboardResponse, ExportResponse, ImportBatch, IndividualCaseRow, TransactionDetail } from '../../../src/domain/dto';
import { INDIVIDUAL_SIMILAR_THRESHOLD, matchSender } from '../../../src/domain/matching';
import { loadMatchIndex } from '../clientMatching/matchingService';
import { currentYearMonth } from '../../../src/domain/month';
import { AppError, all, first, type SqlDb } from '../../db';
import { allocationsForClients, listAliases, listClients, queryTransactions } from '../../repos';

export function listTransactions(db: SqlDb, year?: number) {
  if (year) return queryTransactions(db, 'substr(t.transaction_datetime, 1, 4) = ?', [String(year)]);
  return queryTransactions(db);
}

export async function transactionDetail(db: SqlDb, id: number): Promise<TransactionDetail> {
  const [transaction] = await queryTransactions(db, 't.id = ?', [id]);
  if (!transaction) throw new AppError('거래를 찾을 수 없습니다.', 404);
  const candidates = matchSender(transaction.sender_raw, await loadMatchIndex(db)).candidates;
  const audit = await all<AuditLog>(db, "SELECT * FROM audit_logs WHERE entity_type = 'transaction' AND entity_id = ? ORDER BY id DESC", id);
  return { transaction, candidates, audit };
}

/**
 * 개별건: 거래처로 확정되지 않은 통장 입금 전체 (미매칭 + 확인필요).
 * 거래처가 지정되면 자동으로 목록에서 빠진다. 유사 거래처는 현재 거래처/별칭 기준으로 다시 계산한다.
 */
export async function individualCases(db: SqlDb, year?: number): Promise<IndividualCaseRow[]> {
  const where = "t.deposit_amount > 0 AND COALESCE(m.status, 'UNMATCHED') IN ('UNMATCHED', 'REVIEW_REQUIRED')";
  const rows = year ? await queryTransactions(db, `${where} AND substr(t.transaction_datetime, 1, 4) = ?`, [String(year)]) : await queryTransactions(db, where);
  if (!rows.length) return [];
  const index = await loadMatchIndex(db);
  return rows.map((t) => {
    const m = matchSender(t.sender_raw, index);
    const best = m.candidates[0] ?? null;
    return { ...t, bestCandidate: best, similar: !m.excluded && !m.isGeneric && !!best && best.score >= INDIVIDUAL_SIMILAR_THRESHOLD, isGeneric: m.isGeneric, excluded: !!m.excluded };
  });
}

export async function advisoryData(db: SqlDb, year: number): Promise<AdvisoryResponse> {
  const clients = await listClients(db);
  const allocations = await all<AdvisoryResponse['allocations'][number]>(
    db,
    `SELECT a.id, a.client_id, a.transaction_id, a.service_month, a.payment_date, a.allocated_amount, a.contract_amount_snapshot, a.source,
            t.sender_raw, t.transaction_datetime
     FROM payment_allocations a LEFT JOIN bank_transactions t ON t.id = a.transaction_id
     ORDER BY a.id`,
  );
  // 비활성 거래처는 해당 연도에 배정이 있을 때만 표시
  const yearStr = String(year);
  const withAlloc = new Set(allocations.filter((a) => a.service_month.startsWith(yearStr)).map((a) => a.client_id));
  return {
    year,
    currentMonth: currentYearMonth(),
    clients: clients.filter((c) => c.active || withAlloc.has(c.id)),
    allocations,
  };
}

export async function dashboard(db: SqlDb): Promise<DashboardResponse> {
  const currentMonth = currentYearMonth();
  const sums = await first<{ dep: number | null; wd: number | null }>(
    db,
    'SELECT SUM(deposit_amount) AS dep, SUM(withdrawal_amount) AS wd FROM bank_transactions WHERE substr(transaction_datetime, 1, 7) = ?',
    currentMonth,
  );
  const unmatched = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM bank_transactions t LEFT JOIN transaction_client_matches m ON m.transaction_id = t.id
     WHERE t.deposit_amount > 0 AND COALESCE(m.status, 'UNMATCHED') IN ('UNMATCHED', 'REVIEW_REQUIRED')`,
  );
  const clients = await listClients(db, true);
  const allocs = await allocationsForClients(db, clients.map((c) => c.id));
  const byClient = new Map<number, GridAllocation[]>();
  for (const a of allocs) byClient.set(a.client_id, [...(byClient.get(a.client_id) ?? []), a]);

  // 부분납 거래: 현재 부분납 상태인 월에 배정된 거래
  const monthAgg = new Map<string, { paid: number; due: number; tx: Set<number> }>();
  for (const a of allocs) {
    const k = `${a.client_id}|${a.service_month}`;
    const cur = monthAgg.get(k) ?? { paid: 0, due: a.contract_amount_snapshot, tx: new Set<number>() };
    cur.paid += a.allocated_amount;
    if (a.transaction_id != null) cur.tx.add(a.transaction_id);
    monthAgg.set(k, cur);
  }
  const partialTx = new Set<number>();
  for (const v of monthAgg.values()) if (v.paid > 0 && v.paid < v.due) v.tx.forEach((t) => partialTx.add(t));

  const unpaidClientCount = clients.filter((c) => outstandingMonths(c, byClient.get(c.id) ?? [], currentMonth).length > 0).length;
  const lastImport = await first<{ filename: string; imported_at: string }>(db, 'SELECT filename, imported_at FROM bank_import_batches ORDER BY id DESC LIMIT 1');
  return {
    currentMonth,
    monthDeposit: sums?.dep ?? 0,
    monthWithdrawal: sums?.wd ?? 0,
    unmatchedCount: unmatched?.n ?? 0,
    partialTxCount: partialTx.size,
    unpaidClientCount,
    clientCount: clients.length,
    lastImport,
  };
}

export function listBatches(db: SqlDb): Promise<ImportBatch[]> {
  return all<ImportBatch>(
    db,
    `SELECT b.*, (SELECT COUNT(*) FROM bank_transactions t JOIN transaction_client_matches m ON m.transaction_id = t.id
                  WHERE t.import_batch_id = b.id AND m.status IN ('AUTO_MATCHED', 'MANUAL_MATCHED') AND t.deposit_amount > 0) AS confirmed_rows
     FROM bank_import_batches b ORDER BY b.id DESC`,
  );
}

export async function exportData(db: SqlDb, year: number): Promise<ExportResponse> {
  const [transactions, advisory, clients, batches, individual] = await Promise.all([listTransactions(db), advisoryData(db, year), listClients(db), listBatches(db), individualCases(db)]);
  return { year, currentMonth: advisory.currentMonth, transactions, individual, advisory, clients, batches };
}

export { listAliases };
