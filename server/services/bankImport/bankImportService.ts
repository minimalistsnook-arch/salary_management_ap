import { applyToLedger, buildLedger, type Ledger } from '../../../src/domain/allocation';
import type { ParsedBankRow } from '../../../src/domain/bankExcelParser';
import type { ImportCommitResponse, ImportPreviewRequest, ImportPreviewResponse, PreviewRow, RowDecision, RowKind } from '../../../src/domain/dto';
import { feeWarning, largeDepositWarning } from '../../../src/domain/feeCheck';
import { contentKey, transactionFingerprint } from '../../../src/domain/fingerprint';
import { similarity } from '../../../src/domain/matching';
import { isYearMonth } from '../../../src/domain/month';
import type { Client, MatchStatus } from '../../../src/domain/types';
import { auditStmt } from '../../audit';
import { AppError, all, first, nowIso, placeholders, type SqlDb, type SqlStatement } from '../../db';
import { allocationsForClients, listClients } from '../../repos';
import { learnAliasStmt, loadMatchIndex, matchWithIndex } from '../clientMatching/matchingService';
import { insertAllocationStmts, planForClient } from '../paymentAllocation/allocationService';

const DT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function validateRequest(req: ImportPreviewRequest): void {
  if (!req || typeof req.filename !== 'string' || !req.filename || req.filename.length > 255) throw new AppError('파일명이 올바르지 않습니다.');
  if (typeof req.fileHash !== 'string' || !/^[0-9a-f]{64}$/.test(req.fileHash)) throw new AppError('파일 hash가 올바르지 않습니다.');
  if (!Array.isArray(req.rows) || req.rows.length === 0) throw new AppError('가져올 거래가 없습니다.');
  if (req.rows.length > 20000) throw new AppError('한 번에 20,000행까지 가져올 수 있습니다.');
  const seen = new Set<number>();
  for (const r of req.rows) {
    const where = `Excel ${r?.excelRowNumber}행`;
    if (!Number.isSafeInteger(r.excelRowNumber) || r.excelRowNumber < 1) throw new AppError(`행번호가 올바르지 않습니다: ${where}`);
    if (seen.has(r.excelRowNumber)) throw new AppError(`행번호가 중복되었습니다: ${where}`);
    seen.add(r.excelRowNumber);
    if (typeof r.transactionDatetime !== 'string' || !DT_RE.test(r.transactionDatetime)) throw new AppError(`거래일시 형식이 올바르지 않습니다: ${where}`);
    if (typeof r.senderRaw !== 'string' || r.senderRaw.length > 500) throw new AppError(`보낸분 값이 올바르지 않습니다: ${where}`);
    for (const [k, label] of [['withdrawalAmount', '출금액'], ['depositAmount', '입금액']] as const) {
      if (!Number.isSafeInteger(r[k]) || r[k] < 0) throw new AppError(`${label}은 0 이상의 정수여야 합니다: ${where}`);
    }
  }
}

function cloneLedger(l: Ledger): Ledger {
  return new Map([...l].map(([k, v]) => [k, { ...v }]));
}

async function existingHashes(db: SqlDb, hashes: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < hashes.length; i += 90) {
    const chunk = hashes.slice(i, i + 90);
    const rows = await all<{ transaction_hash: string }>(db, `SELECT transaction_hash FROM bank_transactions WHERE transaction_hash IN (${placeholders(chunk.length)})`, ...chunk);
    rows.forEach((r) => out.add(r.transaction_hash));
  }
  return out;
}

async function existingContent(db: SqlDb, rows: ParsedBankRow[]): Promise<Map<string, { hash: string; filename: string; row: number }>> {
  const out = new Map<string, { hash: string; filename: string; row: number }>();
  const dts = [...new Set(rows.map((r) => r.transactionDatetime))];
  for (let i = 0; i < dts.length; i += 90) {
    const chunk = dts.slice(i, i + 90);
    const found = await all<{ transaction_datetime: string; sender_raw: string; withdrawal_amount: number; deposit_amount: number; transaction_hash: string; filename: string; excel_row_number: number }>(
      db,
      `SELECT t.transaction_datetime, t.sender_raw, t.withdrawal_amount, t.deposit_amount, t.transaction_hash, b.filename, t.excel_row_number
       FROM bank_transactions t JOIN bank_import_batches b ON b.id = t.import_batch_id
       WHERE t.transaction_datetime IN (${placeholders(chunk.length)})`,
      ...chunk,
    );
    for (const f of found) {
      out.set(contentKey({ transactionDatetime: f.transaction_datetime, senderRaw: f.sender_raw, withdrawalAmount: f.withdrawal_amount, depositAmount: f.deposit_amount }), {
        hash: f.transaction_hash,
        filename: f.filename,
        row: f.excel_row_number,
      });
    }
  }
  return out;
}

/** STEP 2~3: 중복 확인, 거래처 매칭, 월분 배정 시뮬레이션 (DB 미반영) */
export async function buildPreview(db: SqlDb, req: ImportPreviewRequest): Promise<ImportPreviewResponse> {
  validateRequest(req);
  const decisions: Record<number, RowDecision> = req.decisions ?? {};
  const alreadyImportedFile = await first<{ id: number; imported_at: string }>(db, 'SELECT id, imported_at FROM bank_import_batches WHERE file_hash = ?', req.fileHash);

  const hashes = await Promise.all(req.rows.map((r) => transactionFingerprint(r)));
  const dupSet = await existingHashes(db, hashes);
  const contentMap = await existingContent(db, req.rows);
  const inFile = new Map<string, number>();

  const index = await loadMatchIndex(db);
  const clients = new Map<number, Client>((await listClients(db)).map((c) => [c.id, c]));

  const rows: PreviewRow[] = req.rows.map((r, i) => {
    const d = decisions[r.excelRowNumber] ?? {};
    if (d.startMonth && !isYearMonth(d.startMonth)) throw new AppError(`첫 적용월 형식이 잘못되었습니다: Excel ${r.excelRowNumber}행`);
    if (d.clientId != null) {
      const c = clients.get(d.clientId);
      if (!c || !c.active) throw new AppError(`선택한 거래처를 찾을 수 없습니다: Excel ${r.excelRowNumber}행`);
    }
    const kind: RowKind = r.depositAmount > 0 && r.withdrawalAmount > 0 ? 'BOTH' : r.depositAmount > 0 ? 'DEPOSIT' : 'WITHDRAWAL';
    const key = contentKey(r);
    let duplicateSuspect: string | null = null;
    const ex = contentMap.get(key);
    if (ex && ex.hash !== hashes[i]) duplicateSuspect = `같은 내용의 거래가 이미 등록되어 있습니다 (${ex.filename} ${ex.row}행).`;
    else if (inFile.has(key)) duplicateSuspect = `같은 파일 ${inFile.get(key)}행과 내용이 같습니다.`;
    inFile.set(key, r.excelRowNumber);

    const autoMatch = matchWithIndex(r.senderRaw, index);
    const manualChosen = d.clientId !== undefined;
    const clientId = manualChosen ? (d.clientId ?? null) : autoMatch.clientId;
    const client = clientId != null ? clients.get(clientId) ?? null : null;
    let matchStatus: MatchStatus;
    if (manualChosen) matchStatus = client ? 'MANUAL_MATCHED' : autoMatch.isGeneric ? 'REVIEW_REQUIRED' : 'UNMATCHED';
    else matchStatus = autoMatch.status;
    const matchType = matchStatus === 'MANUAL_MATCHED' ? 'MANUAL' : autoMatch.matchType;

    return {
      ...r,
      transactionHash: hashes[i],
      kind,
      duplicate: dupSet.has(hashes[i]),
      duplicateSuspect,
      autoMatch,
      clientId: client?.id ?? null,
      clientName: client?.name ?? null,
      contractAmount: client?.current_contract_amount ?? null,
      similarity: client ? (manualChosen ? similarity(r.senderRaw, client.name) : autoMatch.score) : autoMatch.score,
      matchStatus,
      matchType,
      startMonth: d.startMonth ?? null,
      needsStartMonth: false,
      allocation: [],
      unallocated: r.depositAmount,
      allocationError: null,
      feeWarning: client && r.depositAmount > 0 ? feeWarning(r.depositAmount, client.current_contract_amount) : null,
      amountWarning: client && r.depositAmount > 0 ? largeDepositWarning(r.depositAmount, client.current_contract_amount) : null,
      selected: false,
      selectable: false,
      blockReason: null,
      note: d.note ?? null,
    };
  });

  // 배정 시뮬레이션: 확정 대상 입금을 거래일시 순으로 누적 반영
  const clientIds = [...new Set(rows.filter((r) => r.clientId != null).map((r) => r.clientId as number))];
  const allocs = await allocationsForClients(db, clientIds);
  const ledgers = new Map<number, Ledger>(clientIds.map((id) => [id, buildLedger(allocs.filter((a) => a.client_id === id))]));
  const ordered = [...rows].sort((a, b) => a.transactionDatetime.localeCompare(b.transactionDatetime) || a.excelRowNumber - b.excelRowNumber);

  const baseEligible = (r: PreviewRow) => {
    if (r.duplicate) return '이미 등록된 거래';
    if (r.depositAmount <= 0) return '출금 거래 (월분 배정 대상 아님)';
    if (r.clientId == null) return '거래처를 선택해주세요.';
    if (r.matchStatus !== 'AUTO_MATCHED' && r.matchStatus !== 'MANUAL_MATCHED') return '거래처 확인이 필요합니다.';
    return null;
  };

  const tentative: PreviewRow[] = [];
  for (const r of ordered) {
    r.blockReason = baseEligible(r);
    if (r.blockReason) {
      if (r.clientId != null && r.depositAmount > 0 && !r.duplicate) tentative.push(r);
      continue;
    }
    // 자동매칭이라도 사용자가 확정하기 전까지는 '확인대기'. 거래처를 직접 고른 경우만 확정으로 본다.
    const d = decisions[r.excelRowNumber];
    const wantSelected = d?.selected ?? r.matchStatus === 'MANUAL_MATCHED';
    if (!wantSelected) {
      tentative.push(r);
      continue;
    }
    const client = clients.get(r.clientId as number) as Client;
    const ledger = ledgers.get(client.id) as Ledger;
    const plan = planForClient(client, ledger, r.depositAmount, r.startMonth);
    r.startMonth = plan.startMonth;
    r.needsStartMonth = plan.needsStartMonth;
    r.allocation = plan.lines;
    r.unallocated = plan.unallocated;
    r.allocationError = plan.error;
    if (plan.lines.length) {
      applyToLedger(ledger, plan.lines);
      r.selectable = true;
      r.selected = true;
    } else {
      r.blockReason = plan.error;
    }
  }
  // 확정하지 않은 행은 확정 행 반영 이후 기준으로 참고용 배정을 누적 계산 (DB 저장 안 함)
  const tentativeLedgers = new Map<number, Ledger>();
  for (const r of tentative) {
    const client = clients.get(r.clientId as number) as Client;
    if (!tentativeLedgers.has(client.id)) tentativeLedgers.set(client.id, cloneLedger(ledgers.get(client.id) as Ledger));
    const ledger = tentativeLedgers.get(client.id) as Ledger;
    const plan = planForClient(client, ledger, r.depositAmount, r.startMonth);
    if (plan.lines.length) applyToLedger(ledger, plan.lines);
    r.startMonth = plan.startMonth;
    r.needsStartMonth = plan.needsStartMonth;
    r.allocation = plan.lines;
    r.unallocated = plan.unallocated;
    r.allocationError = plan.error;
    r.selectable = !r.blockReason && plan.lines.length > 0;
  }

  return {
    alreadyImportedFile,
    rows,
    summary: {
      total: rows.length,
      duplicates: rows.filter((r) => r.duplicate).length,
      deposits: rows.filter((r) => r.depositAmount > 0).length,
      withdrawals: rows.filter((r) => r.withdrawalAmount > 0).length,
      autoMatched: rows.filter((r) => !r.duplicate && r.depositAmount > 0 && r.matchStatus === 'AUTO_MATCHED').length,
      review: rows.filter((r) => !r.duplicate && r.depositAmount > 0 && r.matchStatus === 'REVIEW_REQUIRED').length,
      unmatched: rows.filter((r) => !r.duplicate && r.depositAmount > 0 && r.matchStatus === 'UNMATCHED').length,
      selected: rows.filter((r) => r.selected).length,
    },
  };
}

/** STEP 5: 최종 저장. 서버에서 preview 를 다시 계산하여 그대로 저장 (원자적 batch) */
export async function commitImport(db: SqlDb, req: ImportPreviewRequest): Promise<ImportCommitResponse> {
  const preview = await buildPreview(db, req);
  if (preview.alreadyImportedFile) {
    return { batchId: preview.alreadyImportedFile.id, inserted: 0, duplicates: preview.rows.length, confirmed: 0, pendingReview: 0, allocations: 0, aliasesLearned: 0 };
  }
  const invalid = preview.rows.filter((r) => req.decisions?.[r.excelRowNumber]?.selected === true && !r.selected);
  if (invalid.length) {
    throw new AppError(
      '확정할 수 없는 항목이 선택되었습니다.',
      400,
      invalid.map((r) => `Excel ${r.excelRowNumber}행: ${r.blockReason ?? r.allocationError ?? '확정 불가'}`),
    );
  }

  const now = nowIso();
  const newRows = preview.rows.filter((r) => !r.duplicate);
  const clients = new Map((await listClients(db)).map((c) => [c.id, c]));
  const batchSub = { sql: 'SELECT id FROM bank_import_batches WHERE file_hash = ?', params: [req.fileHash] };
  const stmts: SqlStatement[] = [
    db
      .prepare('INSERT INTO bank_import_batches (filename, file_hash, total_rows, inserted_rows, duplicate_rows, imported_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(req.filename, req.fileHash, preview.rows.length, newRows.length, preview.rows.length - newRows.length, now),
  ];

  let confirmed = 0;
  let pendingReview = 0;
  let allocationCount = 0;
  let aliasesLearned = 0;
  const startMonthSet = new Set<number>();

  for (const r of newRows) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO bank_transactions (import_batch_id, excel_row_number, bank_row_no, transaction_datetime, sender_raw, withdrawal_amount, deposit_amount, transaction_hash, created_at)
           VALUES ((${batchSub.sql}), ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...batchSub.params, r.excelRowNumber, r.bankRowNo, r.transactionDatetime, r.senderRaw, r.withdrawalAmount, r.depositAmount, r.transactionHash, now),
    );

    let status: MatchStatus;
    let clientId: number | null;
    if (r.selected) {
      status = r.matchStatus;
      clientId = r.clientId;
      confirmed++;
    } else if (r.depositAmount > 0) {
      clientId = r.clientId;
      status = clientId != null || r.autoMatch.isGeneric ? 'REVIEW_REQUIRED' : 'UNMATCHED';
      pendingReview++;
    } else {
      // 출금: 자동매칭된 경우에만 거래처 표시
      clientId = r.matchStatus === 'AUTO_MATCHED' ? r.clientId : null;
      status = clientId != null ? 'AUTO_MATCHED' : 'UNMATCHED';
    }
    const txSub = { idSql: 'SELECT id FROM bank_transactions WHERE transaction_hash = ?', idParams: [r.transactionHash] };
    stmts.push(
      db
        .prepare(
          `INSERT INTO transaction_client_matches (transaction_id, client_id, similarity_score, match_type, status, note, created_at, updated_at)
           VALUES ((${txSub.idSql}), ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...txSub.idParams, clientId, Math.max(0, Math.min(100, r.similarity)), clientId == null ? 'NONE' : r.matchType, status, r.note, now, now),
    );

    if (r.selected && r.clientId != null) {
      stmts.push(...insertAllocationStmts(db, txSub, r.clientId, r.transactionDatetime.slice(0, 10), r.allocation, 'BANK'));
      allocationCount += r.allocation.length;
      if (r.matchStatus === 'MANUAL_MATCHED') {
        const a = learnAliasStmt(db, r.senderRaw, r.clientId);
        if (a) {
          stmts.push(a);
          aliasesLearned++;
        }
      }
      const client = clients.get(r.clientId);
      const chosen = req.decisions?.[r.excelRowNumber]?.startMonth;
      if (client && !client.management_start_month && chosen && !startMonthSet.has(client.id)) {
        startMonthSet.add(client.id);
        stmts.push(db.prepare('UPDATE clients SET management_start_month = ?, updated_at = ? WHERE id = ? AND management_start_month IS NULL').bind(chosen, now, client.id));
        stmts.push(auditStmt(db, 'SET_START_MONTH', 'client', client.id, { management_start_month: null }, { management_start_month: chosen }));
      }
    }
  }
  stmts.push(
    auditStmt(db, 'IMPORT_BANK_FILE', 'bank_import_batch', null, null, {
      filename: req.filename,
      file_hash: req.fileHash,
      total: preview.rows.length,
      inserted: newRows.length,
      confirmed,
      pendingReview,
    }),
  );

  await db.batch(stmts);
  const batch = await first<{ id: number }>(db, batchSub.sql, ...batchSub.params);
  return {
    batchId: batch?.id ?? null,
    inserted: newRows.length,
    duplicates: preview.rows.length - newRows.length,
    confirmed,
    pendingReview,
    allocations: allocationCount,
    aliasesLearned,
  };
}
