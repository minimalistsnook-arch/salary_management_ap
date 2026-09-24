import type { GridAllocation } from '../src/domain/advisoryGrid';
import { monthStatus } from '../src/domain/allocation';
import type { TransactionRow, TxAllocation } from '../src/domain/dto';
import type { Client, ClientAlias, PaymentStatus } from '../src/domain/types';
import { all, first, placeholders, type SqlDb } from './db';

export function listClients(db: SqlDb, activeOnly = false): Promise<Client[]> {
  return all<Client>(db, `SELECT * FROM clients ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY name`);
}

export function getClient(db: SqlDb, id: number): Promise<Client | null> {
  return first<Client>(db, 'SELECT * FROM clients WHERE id = ?', id);
}

export function listAliases(db: SqlDb): Promise<(ClientAlias & { client_name: string })[]> {
  return all(db, 'SELECT a.*, c.name AS client_name FROM client_aliases a JOIN clients c ON c.id = a.client_id ORDER BY a.raw_sender');
}

export async function allocationsForClients(db: SqlDb, clientIds: number[], excludeTransactionId?: number): Promise<GridAllocation[]> {
  if (!clientIds.length) return [];
  const rows = await all<GridAllocation>(
    db,
    `SELECT id, client_id, transaction_id, service_month, payment_date, allocated_amount, contract_amount_snapshot, source
     FROM payment_allocations WHERE client_id IN (${placeholders(clientIds.length)}) ORDER BY id`,
    ...clientIds,
  );
  return excludeTransactionId === undefined ? rows : rows.filter((r) => r.transaction_id !== excludeTransactionId);
}

/** (거래처, 월) → 현재 월 상태 */
async function monthStatusMap(db: SqlDb, clientIds: number[]): Promise<Map<string, PaymentStatus>> {
  const allocs = await allocationsForClients(db, clientIds);
  const agg = new Map<string, { paid: number; due: number }>();
  for (const a of allocs) {
    const k = `${a.client_id}|${a.service_month}`;
    const cur = agg.get(k);
    if (cur) cur.paid += a.allocated_amount;
    else agg.set(k, { paid: a.allocated_amount, due: a.contract_amount_snapshot });
  }
  return new Map([...agg].map(([k, v]) => [k, monthStatus(v.paid, v.due)]));
}

/** 거래 목록 (원본 + 매칭 + 배정). where 절은 bank_transactions t 기준 */
export async function queryTransactions(db: SqlDb, where = '1 = 1', params: unknown[] = []): Promise<TransactionRow[]> {
  const rows = await all<Omit<TransactionRow, 'allocations'>>(
    db,
    `SELECT t.*, b.filename,
            m.client_id, c.name AS client_name, c.current_contract_amount AS contract_amount,
            COALESCE(m.similarity_score, 0) AS similarity_score,
            COALESCE(m.match_type, 'NONE') AS match_type,
            COALESCE(m.status, 'UNMATCHED') AS match_status,
            m.note
     FROM bank_transactions t
     JOIN bank_import_batches b ON b.id = t.import_batch_id
     LEFT JOIN transaction_client_matches m ON m.transaction_id = t.id
     LEFT JOIN clients c ON c.id = m.client_id
     WHERE ${where}
     ORDER BY t.transaction_datetime DESC, t.id DESC`,
    ...params,
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const allocs: (TxAllocation & { transaction_id: number; client_id: number })[] = [];
  // SQLite 변수 개수 제한을 피하기 위해 나눠서 조회
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    allocs.push(
      ...(await all<TxAllocation & { transaction_id: number; client_id: number }>(
        db,
        `SELECT id, transaction_id, client_id, service_month, payment_date, allocated_amount, contract_amount_snapshot, status, source
         FROM payment_allocations WHERE transaction_id IN (${placeholders(chunk.length)}) ORDER BY service_month, id`,
        ...chunk,
      )),
    );
  }
  const statuses = await monthStatusMap(db, [...new Set(allocs.map((a) => a.client_id))]);
  const byTx = new Map<number, TxAllocation[]>();
  for (const a of allocs) {
    const list = byTx.get(a.transaction_id) ?? [];
    list.push({ ...a, month_status: statuses.get(`${a.client_id}|${a.service_month}`) ?? a.status });
    byTx.set(a.transaction_id, list);
  }
  return rows.map((r) => ({ ...r, allocations: byTx.get(r.id) ?? [] }));
}
