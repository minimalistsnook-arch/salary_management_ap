import { beforeEach, describe, expect, test } from 'vitest';
import type { ImportPreviewRequest } from '../../src/domain/dto';
import type { ParsedBankRow } from '../../src/domain/bankExcelParser';
import { createSqliteDb } from '../dev/nodeSqliteDb';
import { buildPreview, commitImport } from './bankImport/bankImportService';
import type { ClientSourceAdapter } from './clientSync/adapters';
import { syncClients } from './clientSync/clientSyncService';
import { assignTransaction, setManualAllocations } from './paymentAllocation/allocationService';
import { individualCases, listTransactions } from './query/queryService';

const sheet = (rows: [string, string, string][]): ClientSourceAdapter => ({ name: 'test', fetchRows: async () => rows.map((r) => [...r]) });
const MASTER: [string, string, string][] = [
  ['', '회 원 사', '계약금액'],
  ['', '남산운수마을버스㈜', '220,000'],
  ['', '광일운수㈜', '275,000'],
  ['', '청진운수㈜', '165,000'],
  ['', '소도수사', '88,000'],
  ['송연탁 ', '소도수사', '88,000'],
];

const row = (n: number, dt: string, sender: string, deposit: number, withdrawal = 0): ParsedBankRow => ({
  excelRowNumber: n,
  bankRowNo: String(n - 1),
  transactionDatetime: dt,
  senderRaw: sender,
  withdrawalAmount: withdrawal,
  depositAmount: deposit,
});

let db: ReturnType<typeof createSqliteDb>;
let clientIds: Record<string, number>;

beforeEach(async () => {
  db = createSqliteDb();
  const r = await syncClients(db, sheet(MASTER));
  expect(r.ok).toBe(true);
  const rows = db.raw.prepare('SELECT id, name FROM clients').all() as { id: number; name: string }[];
  clientIds = Object.fromEntries(rows.map((c) => [c.name, c.id]));
  db.raw.prepare("UPDATE clients SET management_start_month = '2026-05'").run();
});

const count = (sql: string) => (db.raw.prepare(sql).get() as { n: number }).n;

describe('통장 업로드 → 저장', () => {
  const file = (): ImportPreviewRequest => ({
    filename: '신한_2026-09.xlsx',
    fileHash: 'a'.repeat(64),
    rows: [row(2, '2026-09-24 10:00:00', '남산운수 주식회사', 440000), row(3, '2026-09-24 11:00:00', 'CMS집금', 275000), row(4, '2026-09-25 09:00:00', '사무실 임대료', 0, 500000)],
  });

  const confirmed = (): ImportPreviewRequest => ({ ...file(), decisions: { 2: { selected: true } } });

  test('CASE 1: 남산운수 주식회사 440,000 → 2026-05, 2026-06 각 220,000 PAID, 입금일 동일', async () => {
    const preview = await buildPreview(db, file());
    const p = preview.rows[0];
    expect(p.clientName).toBe('남산운수마을버스㈜');
    expect(p.matchStatus).toBe('AUTO_MATCHED');
    expect(p.selected).toBe(false); // 사용자 확정 전에는 확인대기
    expect(p.selectable).toBe(true);
    expect(p.allocation.map((l) => [l.serviceMonth, l.amount, l.status])).toEqual([
      ['2026-05', 220000, 'PAID'],
      ['2026-06', 220000, 'PAID'],
    ]);

    const res = await commitImport(db, confirmed());
    expect(res).toMatchObject({ inserted: 3, duplicates: 0, confirmed: 1, allocations: 2 });
    const allocs = db.raw.prepare('SELECT service_month, allocated_amount, status, payment_date, contract_amount_snapshot FROM payment_allocations ORDER BY service_month').all();
    expect(allocs).toEqual([
      { service_month: '2026-05', allocated_amount: 220000, status: 'PAID', payment_date: '2026-09-24', contract_amount_snapshot: 220000 },
      { service_month: '2026-06', allocated_amount: 220000, status: 'PAID', payment_date: '2026-09-24', contract_amount_snapshot: 220000 },
    ]);
    // RAW 와 PROCESSED 분리
    const tx = db.raw.prepare("SELECT t.sender_raw, c.name AS client_name FROM bank_transactions t JOIN transaction_client_matches m ON m.transaction_id = t.id JOIN clients c ON c.id = m.client_id WHERE t.excel_row_number = 2").get();
    expect(tx).toEqual({ sender_raw: '남산운수 주식회사', client_name: '남산운수마을버스㈜' });
  });

  test('CASE 4: 같은 Excel 파일 2번 업로드 → 거래 중복 생성 0건', async () => {
    await commitImport(db, confirmed());
    const before = count('SELECT COUNT(*) AS n FROM bank_transactions');
    const allocBefore = count('SELECT COUNT(*) AS n FROM payment_allocations');

    const preview = await buildPreview(db, file());
    expect(preview.alreadyImportedFile).not.toBeNull();
    expect(preview.rows.every((r) => r.duplicate)).toBe(true);
    const again = await commitImport(db, file());
    expect(again.inserted).toBe(0);

    // 파일 hash 가 달라도(다시 저장한 파일) 같은 거래는 등록되지 않음
    const resaved = await commitImport(db, { ...file(), fileHash: 'b'.repeat(64) });
    expect(resaved.inserted).toBe(0);
    expect(resaved.duplicates).toBe(3);

    expect(count('SELECT COUNT(*) AS n FROM bank_transactions')).toBe(before);
    expect(count('SELECT COUNT(*) AS n FROM payment_allocations')).toBe(allocBefore);
  });

  test('CASE 9: CMS집금은 자동 지정하지 않고 확인필요로 저장, alias 학습 안 함', async () => {
    await commitImport(db, file());
    const m = db.raw.prepare("SELECT m.status, m.client_id FROM transaction_client_matches m JOIN bank_transactions t ON t.id = m.transaction_id WHERE t.sender_raw = 'CMS집금'").get();
    expect(m).toEqual({ status: 'REVIEW_REQUIRED', client_id: null });

    const txId = (db.raw.prepare("SELECT id FROM bank_transactions WHERE sender_raw = 'CMS집금'").get() as { id: number }).id;
    await assignTransaction(db, txId, { clientId: clientIds['광일운수㈜'] });
    expect(count("SELECT COUNT(*) AS n FROM client_aliases WHERE normalized_sender = 'cms집금'")).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM payment_allocations WHERE transaction_id = ${txId}`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'transaction' AND entity_id = ${txId}`)).toBe(1);
  });

  test('수동 확정한 통장명은 alias 로 학습되어 다음부터 자동 인식', async () => {
    const req: ImportPreviewRequest = { filename: 'f.xlsx', fileHash: 'c'.repeat(64), rows: [row(2, '2026-09-01 10:00:00', '김대표', 275000)] };
    const p = await buildPreview(db, req);
    expect(p.rows[0].matchStatus).toBe('UNMATCHED');
    await commitImport(db, { ...req, decisions: { 2: { clientId: clientIds['광일운수㈜'], selected: true } } });

    const next = await buildPreview(db, { filename: 'g.xlsx', fileHash: 'd'.repeat(64), rows: [row(2, '2026-10-01 10:00:00', '김대표', 275000)] });
    expect(next.rows[0]).toMatchObject({ matchStatus: 'AUTO_MATCHED', matchType: 'ALIAS', clientName: '광일운수㈜' });
  });

  test('관리 시작월이 없으면 "월 배정 필요" → 첫 적용월 선택 후 배정', async () => {
    db.raw.prepare('UPDATE clients SET management_start_month = NULL').run();
    const req: ImportPreviewRequest = { filename: 'f.xlsx', fileHash: 'e'.repeat(64), rows: [row(2, '2026-09-24 10:00:00', '남산운수 주식회사', 440000)] };
    const p = await buildPreview(db, req);
    expect(p.rows[0]).toMatchObject({ needsStartMonth: true, selected: false });

    const withStart = { ...req, decisions: { 2: { startMonth: '2026-05', selected: true } } };
    expect((await buildPreview(db, withStart)).rows[0].allocation.map((l) => l.serviceMonth)).toEqual(['2026-05', '2026-06']);
    await commitImport(db, withStart);
    expect((db.raw.prepare('SELECT management_start_month AS m FROM clients WHERE id = ?').get(clientIds['남산운수마을버스㈜']) as { m: string }).m).toBe('2026-05');
  });

  test('수수료 차감 가능성 행은 자동 선택하지 않음', async () => {
    const p = await buildPreview(db, { filename: 'f.xlsx', fileHash: 'f'.repeat(64), rows: [row(2, '2026-09-24 10:00:00', '남산운수마을버스', 219725)] });
    expect(p.rows[0].feeWarning).toMatch(/수수료/);
    expect(p.rows[0].selected).toBe(false);
  });

  test('확정하지 않은 자동매칭 행은 저장 시 확인필요로 남고 배정되지 않음', async () => {
    const res = await commitImport(db, file());
    expect(res).toMatchObject({ inserted: 3, confirmed: 0, allocations: 0 });
    expect(count("SELECT COUNT(*) AS n FROM transaction_client_matches WHERE status = 'REVIEW_REQUIRED' AND client_id IS NOT NULL")).toBe(1);
  });

  test('같은 거래처 2건: 확정 전 추천 적용월도 누적 계산', async () => {
    const p = await buildPreview(db, { filename: 'f.xlsx', fileHash: '9'.repeat(64), rows: [row(2, '2026-09-01 10:00:00', '남산운수 주식회사', 220000), row(3, '2026-09-20 10:00:00', '남산운수 주식회사', 220000)] });
    expect(p.rows.map((r) => r.allocation.map((l) => l.serviceMonth))).toEqual([['2026-05'], ['2026-06']]);
  });

  test('원본 통장 거래는 수정할 수 없다 (DB 트리거)', async () => {
    await commitImport(db, file());
    expect(() => db.raw.prepare("UPDATE bank_transactions SET sender_raw = '변경'").run()).toThrow(/immutable/);
  });

  test('배정 수동 수정: 입금액 초과 금지 + 이력 기록', async () => {
    await commitImport(db, confirmed());
    const [tx] = (await listTransactions(db)).filter((t) => t.sender_raw === '남산운수 주식회사');
    await expect(setManualAllocations(db, tx.id, { lines: [{ serviceMonth: '2026-07', amount: 500000 }] })).rejects.toThrow(/초과/);
    await setManualAllocations(db, tx.id, { lines: [{ serviceMonth: '2026-07', amount: 220000 }, { serviceMonth: '2026-08', amount: 110000 }], note: '거래처 요청' });
    const [after] = (await listTransactions(db)).filter((t) => t.id === tx.id);
    expect(after.allocations.map((a) => [a.service_month, a.allocated_amount, a.month_status])).toEqual([
      ['2026-07', 220000, 'PAID'],
      ['2026-08', 110000, 'PARTIAL'],
    ]);
    expect(after.note).toBe('거래처 요청');
  });
});

describe('개별건', () => {
  test('확정되지 않은 입금은 모두 개별건, 유사도 40% 이상 표시, 거래처 지정 시 제외', async () => {
    await commitImport(db, {
      filename: 'f.xlsx',
      fileHash: '5'.repeat(64),
      rows: [
        row(2, '2026-09-24 10:00:00', '남산운수 주식회사', 440000),
        row(3, '2026-09-24 11:00:00', 'CMS집금', 275000),
        row(4, '2026-09-24 12:00:00', '홍길동', 50000),
        row(5, '2026-09-24 13:00:00', '광일상사', 70000),
        row(6, '2026-09-25 09:00:00', '사무실 임대료', 0, 500000),
      ],
      decisions: { 2: { selected: true } },
    });
    const list = await individualCases(db);
    expect(list.map((r) => r.sender_raw).sort()).toEqual(['CMS집금', '광일상사', '홍길동']); // 확정건·출금 제외
    const byName = Object.fromEntries(list.map((r) => [r.sender_raw, r]));
    expect(byName['광일상사'].similar).toBe(true);
    expect(byName['광일상사'].bestCandidate?.clientName).toBe('광일운수㈜');
    expect(byName['광일상사'].bestCandidate!.score).toBeGreaterThanOrEqual(40);
    expect(byName['홍길동'].similar).toBe(false);
    expect(byName['CMS집금']).toMatchObject({ isGeneric: true });

    await assignTransaction(db, byName['광일상사'].id, { clientId: clientIds['광일운수㈜'] });
    expect((await individualCases(db)).map((r) => r.sender_raw)).not.toContain('광일상사');
  });
});

describe('시트 A열 별칭', () => {
  test('A열 표기와 비슷한 통장명 → B열 거래처로 기재 (거래처는 중복 생성 안 함)', async () => {
    expect(count("SELECT COUNT(*) AS n FROM clients WHERE name = '소도수사'")).toBe(1);
    const p = await buildPreview(db, {
      filename: 'f.xlsx',
      fileHash: '7'.repeat(64),
      rows: [row(2, '2026-09-24 10:00:00', '송연탁', 88000), row(3, '2026-09-24 11:00:00', '송연탁(소도)', 88000)],
    });
    expect(p.rows[0]).toMatchObject({ clientName: '소도수사', matchStatus: 'AUTO_MATCHED', matchType: 'ALIAS' });
    expect(p.rows[1]).toMatchObject({ clientName: '소도수사', matchStatus: 'AUTO_MATCHED' });
    expect(p.rows[1].autoMatch.candidates[0].viaAlias).toBe('송연탁');
  });
});

describe('거래처 동기화', () => {
  test('실패 시 기존 거래처 데이터 유지 + 실패 기록', async () => {
    const before = count('SELECT COUNT(*) AS n FROM clients');
    const r = await syncClients(db, { name: 'broken', fetchRows: async () => { throw new Error('network down'); } });
    expect(r.ok).toBe(false);
    expect(r.status.lastSuccess).not.toBeNull();
    expect(r.status.lastAttempt?.status).toBe('FAILED');
    expect(count('SELECT COUNT(*) AS n FROM clients')).toBe(before);
  });

  test('계약금액 변경 시 과거 배정 snapshot 은 유지', async () => {
    await commitImport(db, {
      filename: 'f.xlsx',
      fileHash: 'a'.repeat(64),
      rows: [row(2, '2026-09-24 10:00:00', '남산운수 주식회사', 440000)],
      decisions: { 2: { selected: true } },
    });
    await syncClients(db, sheet(MASTER.map((r) => (r[1] === '남산운수마을버스㈜' ? ['', r[1], '275,000'] : r))));
    expect(count("SELECT current_contract_amount AS n FROM clients WHERE name = '남산운수마을버스㈜'")).toBe(275000);
    expect(count('SELECT COUNT(*) AS n FROM payment_allocations WHERE contract_amount_snapshot = 220000')).toBe(2);
  });

  test('시트에서 사라진 거래처는 삭제하지 않고 비활성화', async () => {
    await syncClients(db, sheet(MASTER.filter((r) => r[1] !== '청진운수㈜')));
    expect(count("SELECT active AS n FROM clients WHERE name = '청진운수㈜'")).toBe(0);
  });
});
