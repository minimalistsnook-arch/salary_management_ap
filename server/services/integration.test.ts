import { beforeEach, describe, expect, test } from 'vitest';
import type { ImportPreviewRequest } from '../../src/domain/dto';
import type { ParsedBankRow } from '../../src/domain/bankExcelParser';
import { createSqliteDb } from '../dev/nodeSqliteDb';
import { buildPreview, commitImport } from './bankImport/bankImportService';
import type { ClientSourceAdapter } from './clientSync/adapters';
import { syncClients } from './clientSync/clientSyncService';
import { assignTransaction, setManualAllocations } from './paymentAllocation/allocationService';
import { bulkTransactions } from './paymentAllocation/bulkService';
import { applyBaseline, previewBaseline } from './baseline/baselineService';
import { dashboard, individualCases, listTransactions } from './query/queryService';

const sheet = (rows: [string, string, string][]): ClientSourceAdapter => ({ name: 'test', fetchRows: async () => rows.map((r) => [...r]) });
const MASTER: [string, string, string][] = [
  ['', '회 원 사', '계약금액'],
  ['', '남산운수마을버스㈜', '220,000'],
  ['', '광일운수㈜', '275,000'],
  ['', '청진운수㈜', '165,000'],
  ['', '소도수사', '88,000'],
  ['송연탁 ', '소도수사', '88,000'],
  ['경원여객', 'x', ''],
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

describe('일괄 처리 (V 선택)', () => {
  const seed = async () => {
    db.raw.prepare('UPDATE clients SET management_start_month = NULL').run();
    await commitImport(db, {
      filename: 'f.xlsx',
      fileHash: '4'.repeat(64),
      rows: [
        row(2, '2026-09-01 10:00:00', '남산운수 주식회사', 220000),
        row(3, '2026-09-10 10:00:00', '남산운수 주식회사', 440000),
        row(4, '2026-09-11 10:00:00', '광일운수(주)', 275000),
        row(5, '2026-09-12 10:00:00', 'CMS집금', 165000),
      ],
    });
    const txs = await listTransactions(db);
    return Object.fromEntries(txs.map((t) => [t.excel_row_number, t.id])) as Record<number, number>;
  };

  test('확인필요 여러 건을 첫 적용월과 함께 일괄 확정 (같은 거래처는 거래일시 순 누적)', async () => {
    const id = await seed();
    const noMonth = await bulkTransactions(db, { action: 'confirm', ids: [id[2], id[3], id[4]] });
    expect(noMonth.done).toBe(0);
    expect(noMonth.failed).toHaveLength(3); // 월 배정 필요

    const r = await bulkTransactions(db, { action: 'confirm', ids: [id[3], id[2], id[4], id[5]], startMonth: '2026-05' });
    expect(r.done).toBe(3);
    expect(r.failed.map((f) => f.id)).toEqual([id[5]]); // CMS집금은 추천 거래처 없음
    const txs = await listTransactions(db);
    const months = (row: number) => txs.find((t) => t.id === id[row])!.allocations.map((a) => a.service_month);
    expect(months(2)).toEqual(['2026-05']);
    expect(months(3)).toEqual(['2026-06', '2026-07']);
    expect(months(4)).toEqual(['2026-05']);
    expect(txs.find((t) => t.id === id[2])!.match_status).toBe('MANUAL_MATCHED');
    expect(count("SELECT COUNT(*) AS n FROM clients WHERE management_start_month = '2026-05'")).toBe(2);

    // 이미 확정된 건은 건너뜀
    expect((await bulkTransactions(db, { action: 'confirm', ids: [id[2]] })).skipped).toHaveLength(1);
    // CMS집금은 거래처를 지정해서 일괄 확정
    const cms = await bulkTransactions(db, { action: 'confirm', ids: [id[5]], clientId: clientIds['청진운수㈜'], startMonth: '2026-08' });
    expect(cms.done).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM client_aliases WHERE normalized_sender = 'cms집금'")).toBe(0);
  });

  test('일괄 확정은 경고 건(큰 금액·수수료 차감)을 기본으로 건너뜀', async () => {
    db.raw.prepare("UPDATE clients SET management_start_month = '2026-05'").run();
    await commitImport(db, {
      filename: 'w.xlsx',
      fileHash: '6'.repeat(64),
      rows: [row(2, '2026-09-01 10:00:00', '남산운수 주식회사', 3300000), row(3, '2026-09-02 10:00:00', '광일운수(주)', 274725)],
    });
    const ids = (await listTransactions(db)).map((t) => t.id);
    const r = await bulkTransactions(db, { action: 'confirm', ids });
    expect(r.done).toBe(0);
    expect(r.skipped.map((s) => s.reason).join()).toMatch(/개월분.*|수수료/);
    expect((await bulkTransactions(db, { action: 'confirm', ids, includeWarnings: true })).done).toBe(2);
  });

  test('적용월 일괄 변경 · 일괄 취소', async () => {
    const id = await seed();
    await bulkTransactions(db, { action: 'confirm', ids: [id[2], id[3]], startMonth: '2026-05' });
    const r = await bulkTransactions(db, { action: 'redate', ids: [id[2], id[3]], startMonth: '2026-08' });
    expect(r.done).toBe(2);
    let txs = await listTransactions(db);
    expect(txs.find((t) => t.id === id[2])!.allocations.map((a) => a.service_month)).toEqual(['2026-08']);
    expect(txs.find((t) => t.id === id[3])!.allocations.map((a) => a.service_month)).toEqual(['2026-09', '2026-10']);

    const u = await bulkTransactions(db, { action: 'unassign', ids: [id[2], id[3]] });
    expect(u.done).toBe(2);
    txs = await listTransactions(db);
    expect(txs.find((t) => t.id === id[2])).toMatchObject({ match_status: 'REVIEW_REQUIRED', allocations: [] });
    expect(txs.find((t) => t.id === id[2])!.client_name).toBe('남산운수마을버스㈜'); // 추천은 유지
    expect(count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'BULK_%'`)).toBe(6);
  });
});

describe('마지막 입금 기준표', () => {
  const table = [
    '1    광일운수㈜    275,000    통장입금    10    7월분    08/19    영옥',
    '2    청진운수㈜    165,000    CMS    10    7월분    09/10    영옥',
    '3    남산운수마을버스㈜    220,000    통장입금    말일    입금기록 없음        민주',
  ].join('\n');

  test('통장 입금이 기준일과 같으면 그 입금 = 기준 월분, 이전은 거꾸로, 이후는 다음 월분 / 없으면 기존 기록', async () => {
    await commitImport(db, {
      filename: 'b.xlsx',
      fileHash: '2'.repeat(64),
      rows: [
        row(2, '2026-08-18 16:29:00', '광일운수(주)', 275000),
        row(3, '2026-08-19 10:29:00', '광일운수(주)', 275000),
        row(4, '2026-08-19 10:29:30', '광일운수(주)', 275000),
        row(5, '2026-09-15 11:12:00', '광일운수(주)', 275000),
      ],
      decisions: { 2: { selected: true }, 3: { selected: true }, 4: { selected: true }, 5: { selected: true } }, // 잘못된 기존 확정 (2026-05~)
    });
    const p = await previewBaseline(db, { text: table, reference: '2026-09-24' });
    const kw = p.rows.find((r) => r.name === '광일운수㈜')!;
    expect(kw.baselineRecord).toBeNull();
    expect(kw.deposits.map((d) => [d.date, d.after])).toEqual([
      ['2026-08-18', ['2026-05']],
      ['2026-08-19', ['2026-06']],
      ['2026-08-19', ['2026-07']],
      ['2026-09-15', ['2026-08']],
    ]);
    const cj = p.rows.find((r) => r.name === '청진운수㈜')!;
    expect(cj.baselineRecord).toEqual({ month: '2026-07', date: '2026-09-10', amount: 165000 });
    expect(p.rows.find((r) => r.name === '남산운수마을버스㈜')!.mode).toBe('NO_RECORD');

    const r1 = await applyBaseline(db, { text: table, reference: '2026-09-24' });
    expect(r1).toMatchObject({ clients: 2, baselineRecords: 1, deposits: 4, metaOnly: 1 });
    // 재적용해도 같은 결과 (중복 없음)
    await applyBaseline(db, { text: table, reference: '2026-09-24' });
    expect(count(`SELECT COUNT(*) AS n FROM payment_allocations WHERE client_id = ${clientIds['광일운수㈜']}`)).toBe(4);
    expect(count(`SELECT COUNT(*) AS n FROM payment_allocations WHERE client_id = ${clientIds['청진운수㈜']}`)).toBe(1);
    expect((db.raw.prepare('SELECT management_start_month AS m, manager, contract_type FROM clients WHERE id = ?').get(clientIds['광일운수㈜']) as Record<string, string>)).toEqual({
      m: '2026-05',
      manager: '영옥',
      contract_type: '통장입금',
    });

    // 다음 통장 Excel 업로드 → 그다음 월분부터 자동
    const next = await buildPreview(db, {
      filename: 'next.xlsx',
      fileHash: '1'.repeat(64),
      rows: [row(2, '2026-10-10 10:00:00', '광일운수(주)', 275000), row(3, '2026-10-10 11:00:00', '청진운수주식회사', 165000)],
    });
    expect(next.rows.map((r) => [r.clientName, r.needsStartMonth, r.allocation.map((l) => l.serviceMonth)])).toEqual([
      ['광일운수㈜', false, ['2026-09']],
      ['청진운수㈜', false, ['2026-08']],
    ]);
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

describe('시트 x 제외', () => {
  test('동기화 시 x 입금처 저장 → 업로드에서 미매칭, 개별건으로', async () => {
    expect(count('SELECT COUNT(*) AS n FROM sender_exclusions')).toBe(1);
    const req = { filename: 'f.xlsx', fileHash: '3'.repeat(64), rows: [row(2, '2026-08-31 11:34:00', '경원여객자동차(주)', 2200000)] };
    const p = await buildPreview(db, req);
    expect(p.rows[0]).toMatchObject({ matchStatus: 'UNMATCHED', clientId: null });
    expect(p.rows[0].autoMatch.excluded).toBe(true);
    await commitImport(db, req);
    const [ind] = await individualCases(db);
    expect(ind).toMatchObject({ sender_raw: '경원여객자동차(주)', excluded: true, similar: false });
    // 재동기화해도 중복 생성 없음
    await syncClients(db, sheet(MASTER));
    expect(count('SELECT COUNT(*) AS n FROM sender_exclusions')).toBe(1);
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

describe('거래처 시트 A열 + 추천 갱신', () => {
  test('A열에 통장명이 있는 거래처 행도 등록되고, 저장된 미매칭 입금에 추천이 붙음', async () => {
    const without = MASTER.filter((r) => r[1] !== '남산운수마을버스㈜');
    await syncClients(db, sheet(without));
    await commitImport(db, { filename: 'n.xlsx', fileHash: '8'.repeat(64), rows: [row(2, '2026-08-28 11:31:00', '(주)마을버스남산운수', 220000)] });
    const [before] = await listTransactions(db);
    expect(before.client_id).toBeNull();

    const r = await syncClients(db, sheet([...without, ['(주)마을버스남산운수', '남산운수마을버스㈜', '220,000']]));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/추천 갱신 1/);
    expect(count("SELECT active AS n FROM clients WHERE name = '남산운수마을버스㈜'")).toBe(1);
    const [after] = await listTransactions(db);
    expect(after).toMatchObject({ client_name: '남산운수마을버스㈜', match_status: 'REVIEW_REQUIRED', allocations: [] });
  });
});

describe('거래처가 많을 때 (D1 변수 100개 제한)', () => {
  test('거래처 150곳 + 배정이 있어도 대시보드·노무자문비 조회 성공', async () => {
    const many: [string, string, string][] = [['', '회 원 사', '계약금액'], ...Array.from({ length: 150 }, (_, i) => ['', `테스트거래처${i}`, '110,000'] as [string, string, string])];
    await syncClients(db, sheet([...MASTER, ...many.slice(1)]));
    db.raw.prepare("UPDATE clients SET management_start_month = '2026-05'").run();
    const d = await dashboard(db);
    expect(d.clientCount).toBeGreaterThan(150);
    expect(d.unpaidClientCount).toBeGreaterThan(150);
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
