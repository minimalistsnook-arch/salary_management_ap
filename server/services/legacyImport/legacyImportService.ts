import type { LegacyCommitResponse, LegacyPreviewRequest, LegacyPreviewResponse, LegacyPreviewRow } from '../../../src/domain/dto';
import { compareMonths, isYearMonth } from '../../../src/domain/month';
import type { Client } from '../../../src/domain/types';
import { auditStmt } from '../../audit';
import { AppError, nowIso, type SqlDb, type SqlStatement } from '../../db';
import { allocationsForClients, listClients } from '../../repos';
import { loadMatchIndex, matchWithIndex } from '../clientMatching/matchingService';

/**
 * 기존 '노무자문비' 시트 → 초기 월별 입금 상태 (최초 1회).
 * 셀에 입금일만 있으므로 해당 월은 계약금액 전액 납부(완납)로 기록한다.
 * 한 셀에 여러 날짜가 있으면 계약금액을 날짜 수로 나눠 기록하고 경고를 남긴다.
 */
export async function previewLegacy(db: SqlDb, req: LegacyPreviewRequest): Promise<LegacyPreviewResponse> {
  if (!Array.isArray(req.clients) || !req.clients.length) throw new AppError('가져올 거래처 행이 없습니다.');
  const index = await loadMatchIndex(db);
  const clients = new Map<number, Client>((await listClients(db)).map((c) => [c.id, c]));
  const mapping = req.mapping ?? {};
  const mappedIds = new Set<number>();
  const rows: LegacyPreviewRow[] = req.clients.map((lc) => {
    for (const p of lc.payments) {
      if (!isYearMonth(p.serviceMonth) || !p.paymentDates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
        throw new AppError(`Excel ${lc.excelRowNumber}행 '${lc.name}': 월/날짜 형식이 올바르지 않습니다.`);
      }
    }
    const autoMatch = matchWithIndex(lc.name, index);
    const chosen = lc.excelRowNumber in mapping ? mapping[lc.excelRowNumber] : autoMatch.status === 'AUTO_MATCHED' ? autoMatch.clientId : null;
    const client = chosen != null ? clients.get(chosen) ?? null : null;
    if (client) mappedIds.add(client.id);
    const months = lc.payments.map((p) => p.serviceMonth).sort(compareMonths);
    return {
      ...lc,
      autoMatch,
      clientId: client?.id ?? null,
      clientName: client?.name ?? null,
      snapshotAmount: lc.contractAmount ?? client?.current_contract_amount ?? null,
      firstMonth: months[0] ?? null,
      monthCount: months.length,
      existingMonths: 0,
      warnings: lc.payments.filter((p) => p.paymentDates.length > 1).map((p) => `${p.serviceMonth}: 입금일 ${p.paymentDates.length}건 — 계약금액을 균등 분할해 기록`),
    };
  });
  const allocs = await allocationsForClients(db, [...mappedIds]);
  const existing = new Set(allocs.map((a) => `${a.client_id}|${a.service_month}`));
  for (const r of rows) {
    if (r.clientId != null) r.existingMonths = r.payments.filter((p) => existing.has(`${r.clientId}|${p.serviceMonth}`)).length;
    if (r.clientId != null && !r.snapshotAmount) r.warnings.push('계약금액이 없어 가져올 수 없습니다.');
  }
  const dupTargets = new Map<number, number>();
  for (const r of rows) if (r.clientId != null) dupTargets.set(r.clientId, (dupTargets.get(r.clientId) ?? 0) + 1);
  for (const r of rows) if (r.clientId != null && (dupTargets.get(r.clientId) ?? 0) > 1) r.warnings.push('다른 행과 같은 거래처로 연결되어 있습니다.');
  return { rows };
}

export async function commitLegacy(db: SqlDb, req: LegacyPreviewRequest): Promise<LegacyCommitResponse> {
  const { rows } = await previewLegacy(db, req);
  const clients = new Map<number, Client>((await listClients(db)).map((c) => [c.id, c]));
  const existing = new Set((await allocationsForClients(db, [...new Set(rows.flatMap((r) => (r.clientId != null ? [r.clientId] : [])))])).map((a) => `${a.client_id}|${a.service_month}`));
  const now = nowIso();
  const stmts: SqlStatement[] = [];
  let allocations = 0;
  let skippedMonths = 0;
  const touched = new Set<number>();
  const startMonths = new Map<number, string>();

  for (const r of rows) {
    if (r.clientId == null || !r.snapshotAmount) continue;
    const snap = r.snapshotAmount;
    for (const p of r.payments) {
      const k = `${r.clientId}|${p.serviceMonth}`;
      if (existing.has(k)) {
        skippedMonths++;
        continue;
      }
      existing.add(k);
      const n = p.paymentDates.length;
      const base = Math.floor(snap / n);
      p.paymentDates.forEach((date, i) => {
        const amount = i === n - 1 ? snap - base * (n - 1) : base;
        if (amount <= 0) return;
        allocations++;
        stmts.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO payment_allocations (transaction_id, client_id, service_month, payment_date, allocated_amount, contract_amount_snapshot, status, source, legacy_key, created_at)
               VALUES (NULL, ?, ?, ?, ?, ?, ?, 'LEGACY', ?, ?)`,
            )
            .bind(r.clientId, p.serviceMonth, date, amount, snap, i === n - 1 ? 'PAID' : 'PARTIAL', `L|${r.clientId}|${p.serviceMonth}|${date}|${i}`, now),
        );
      });
      touched.add(r.clientId);
      const cur = startMonths.get(r.clientId);
      if (!cur || p.serviceMonth < cur) startMonths.set(r.clientId, p.serviceMonth);
    }
  }
  // 계약기간·계약형태·입금예상일·담당 (값이 있는 항목만 갱신)
  let metaUpdated = 0;
  for (const r of rows) {
    if (r.clientId == null || !r.meta) continue;
    const m = r.meta;
    if (![m.contractStart, m.contractEnd, m.contractType, m.expectedPayDay, m.manager, m.seq].some(Boolean)) continue;
    metaUpdated++;
    stmts.push(
      db
        .prepare(
          `UPDATE clients SET contract_start = COALESCE(?, contract_start), contract_end = COALESCE(?, contract_end), contract_type = COALESCE(?, contract_type),
             expected_pay_day = COALESCE(?, expected_pay_day), manager = COALESCE(?, manager), legacy_seq = COALESCE(?, legacy_seq), updated_at = ? WHERE id = ?`,
        )
        .bind(m.contractStart, m.contractEnd, m.contractType, m.expectedPayDay, m.manager, m.seq, now, r.clientId),
    );
  }

  for (const [clientId, month] of startMonths) {
    const c = clients.get(clientId);
    if (c && !c.management_start_month) {
      stmts.push(db.prepare('UPDATE clients SET management_start_month = ?, updated_at = ? WHERE id = ? AND management_start_month IS NULL').bind(month, now, clientId));
      stmts.push(auditStmt(db, 'SET_START_MONTH', 'client', clientId, { management_start_month: null }, { management_start_month: month, reason: 'LEGACY_IMPORT' }));
    }
  }
  stmts.push(auditStmt(db, 'IMPORT_LEGACY_ADVISORY', 'payment_allocations', null, null, { clients: touched.size, allocations, skippedMonths, metaUpdated }));
  await db.batch(stmts);
  return { clients: touched.size, allocations, skippedMonths };
}
