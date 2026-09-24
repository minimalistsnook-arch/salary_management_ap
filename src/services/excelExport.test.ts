import * as XLSX from 'xlsx';
import * as XLSXStyle from 'xlsx-js-style';
import { describe, expect, test } from 'vitest';
import type { ExportResponse, TransactionRow } from '../domain/dto';
import type { Client } from '../domain/types';
import { buildIncomeRows, buildWorkbook, monthMemo, splitVat } from './excelExport';

const client = (id: number, name: string, amount: number, extra: Partial<Client> = {}): Client => ({
  id,
  name,
  current_contract_amount: amount,
  management_start_month: '2026-05',
  source_row: id + 2,
  active: 1,
  created_at: '',
  updated_at: '',
  ...extra,
});

const tx = (id: number, dt: string, sender: string, deposit: number, clientName: string | null, allocs: [string, number][] = []): TransactionRow => ({
  id,
  import_batch_id: 1,
  excel_row_number: id,
  bank_row_no: null,
  transaction_datetime: dt,
  sender_raw: sender,
  withdrawal_amount: 0,
  deposit_amount: deposit,
  transaction_hash: String(id),
  created_at: '',
  filename: 'f.xlsx',
  client_id: clientName ? 1 : null,
  client_name: clientName,
  contract_amount: 220000,
  similarity_score: 80,
  match_type: 'FUZZY',
  match_status: clientName ? 'MANUAL_MATCHED' : 'UNMATCHED',
  note: null,
  allocations: allocs.map(([m, a], i) => ({ id: id * 10 + i, service_month: m, payment_date: dt.slice(0, 10), allocated_amount: a, contract_amount_snapshot: 220000, status: 'PAID', source: 'BANK', month_status: 'PAID' })),
});

const clients = [
  client(1, '청담웨딩프라자', 220000, { contract_start: '2006-07-15', contract_end: '2007-07-14', contract_type: '통장입금', expected_pay_day: '20', manager: '재원' }),
  client(2, '세인트팩㈜', 110000),
];
const transactions = [
  tx(1, '2026-09-23 10:00:00', '더청담', 440000, '청담웨딩프라자', [
    ['2026-08', 220000],
    ['2026-09', 220000],
  ]),
  tx(2, '2026-09-24 11:00:00', 'CMS집금', 219725, null),
  tx(3, '2026-01-05 09:00:00', '더청담', 330000, '청담웨딩프라자', [['2025-12', 220000]]),
];
const data: ExportResponse = {
  year: 2026,
  currentMonth: '2026-09',
  transactions,
  individual: [{ ...transactions[1], bestCandidate: null, similar: false, isGeneric: true, excluded: false }],
  clients,
  batches: [],
  advisory: {
    year: 2026,
    currentMonth: '2026-09',
    clients,
    allocations: [
      { id: 1, client_id: 1, transaction_id: null, service_month: '2024-03', payment_date: '2024-03-20', allocated_amount: 220000, contract_amount_snapshot: 220000, source: 'LEGACY', sender_raw: null, transaction_datetime: null },
      { id: 2, client_id: 1, transaction_id: 1, service_month: '2026-08', payment_date: '2026-09-10', allocated_amount: 110000, contract_amount_snapshot: 220000, source: 'BANK', sender_raw: 'x', transaction_datetime: null },
      { id: 3, client_id: 1, transaction_id: 1, service_month: '2026-08', payment_date: '2026-09-23', allocated_amount: 110000, contract_amount_snapshot: 220000, source: 'BANK', sender_raw: 'x', transaction_datetime: null },
    ],
  },
};

const cell = (ws: XLSX.WorkSheet, a1: string) => ws[a1]?.v;

describe('Excel 추출 양식', () => {
  test('적요·부가세 규칙', () => {
    expect(monthMemo('청담웨딩프라자', '2026-08', '2026-09-23')).toBe('청담웨딩프라자 8월');
    expect(monthMemo('청담웨딩프라자', '2025-12', '2026-01-05')).toBe('청담웨딩프라자 25년 12월');
    expect(splitVat(220000)).toEqual({ supply: 200000, vat: 20000 });
    expect(splitVat(219725)).toEqual({ supply: 199750, vat: 19975 });
  });

  test('입출금내역: 모든 입금, 여러 달은 월별로 나눔, 합계 = 통장 입금 합계', () => {
    const rows = buildIncomeRows(transactions, 2026);
    expect(rows.map((r) => [r.date, r.memo, r.amount])).toEqual([
      ['2026-01-05', '청담웨딩프라자 25년 12월', 220000],
      ['2026-01-05', '청담웨딩프라자 (미배정)', 110000],
      ['2026-09-23', '청담웨딩프라자 8월', 220000],
      ['2026-09-23', '청담웨딩프라자 9월', 220000],
      ['2026-09-24', 'CMS집금', 219725],
    ]);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(440000 + 219725 + 330000);
  });

  test('시트 구성과 셀 위치', () => {
    const wb = buildWorkbook(XLSX, data, 2026);
    expect(wb.SheetNames).toEqual(['입출금내역', '급여관리', '개별건', '노무자문비']);

    const inc = wb.Sheets['입출금내역'];
    expect(cell(inc, 'B2')).toBe('수입');
    expect([cell(inc, 'B3'), cell(inc, 'C3'), cell(inc, 'D3')]).toEqual(['입금일', '적요', '수입금액']);
    expect(cell(inc, 'C6')).toBe('청담웨딩프라자 8월');
    expect(cell(inc, 'D6')).toBe(220000);
    expect(inc['B6'].z).toBe('m"월" d"일"');
    expect(XLSX.SSF.format(inc['B6'].z as string, inc['B6'].v as number)).toBe('9월 23일');

    const fee = wb.Sheets['급여관리'];
    expect(['A1', 'B1', 'C1', 'D1', 'E1', 'F1'].map((a) => cell(fee, a))).toEqual(['번호', '이름', '공급가액', '부가세', '입금일', '입금액']);
    expect(['A2', 'B2', 'C2', 'D2', 'F2'].map((a) => cell(fee, a))).toEqual([1, '청담웨딩프라자 25년 12월', 200000, 20000, 220000]);

    const ind = wb.Sheets['개별건'];
    expect(['A1', 'B1', 'C1', 'D1', 'E1', 'F1'].map((a) => cell(ind, a))).toEqual(['번호', '상호', '공급가액', '부가세', '입금일', '입금액']);
    expect(['A2', 'B2', 'C2', 'D2', 'F2'].map((a) => cell(ind, a))).toEqual([1, 'CMS집금', 199750, 19975, 219725]);
  });

  test('노무자문비: 1행 제목, 2행 연도, 3행 월, E 회원사, F 계약금액, I열부터 입금일, 마지막 담당', () => {
    const ws = buildWorkbook(XLSX, data, null).Sheets['노무자문비'];
    expect(cell(ws, 'A1')).toBe('[ 매 출 ]-회원사');
    expect(['A2', 'B2', 'E2', 'F2', 'G2', 'H2'].map((a) => cell(ws, a))).toEqual(['연번', '계약기간', '회     원     사', '계약금액', '계약형태', '입금예상일']);
    // 2024 ~ 2026 → I2 '2024 년도', U2 '2025년', AG2 '2026년'
    expect([cell(ws, 'I2'), cell(ws, 'U2'), cell(ws, 'AG2')]).toEqual(['2024 년도', '2025년', '2026년']);
    expect([cell(ws, 'I3'), cell(ws, 'T3')]).toEqual(['1월', '12월']);
    expect(cell(ws, 'AS2')).toBe('담당');
    // 청담웨딩프라자 (연번 1)
    expect(['A4', 'B4', 'C4', 'D4', 'E4', 'F4', 'G4', 'H4'].map((a) => cell(ws, a))).toEqual([1, '2006-07-15', '~', '2007-07-14', '청담웨딩프라자', 220000, '통장입금', '20']);
    expect(cell(ws, 'K4')).toBe('3/20'); // 2024-03
    expect(cell(ws, 'AN4')).toBe('9/10,9/23'); // 2026-08 두 번 입금
    expect(cell(ws, 'AS4')).toBe('재원');
    expect(cell(ws, 'E5')).toBe('세인트팩㈜');
    expect(ws['!merges']?.some((m) => m.s.r === 1 && m.s.c === 8 && m.e.c === 19)).toBe(true); // 연도 12칸 병합
  });

  test('노무자문비: 거래처별 마지막 입금월 셀은 보라색 (파일 저장 후에도 유지)', () => {
    const X = XLSXStyle as unknown as typeof XLSX;
    const wb = buildWorkbook(X, data, null);
    const buf = X.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const back = X.read(buf, { type: 'buffer', cellStyles: true }).Sheets['노무자문비'];
    const fill = (a1: string) => (back[a1] as { s?: { fgColor?: { rgb?: string } } } | undefined)?.s?.fgColor?.rgb;
    expect(cell(back, 'AN4')).toBe('9/10,9/23'); // 청담웨딩프라자 마지막 입금월 2026-08
    expect(fill('AN4')).toBe('C9A7F0');
    expect(fill('K4')).toBeUndefined(); // 이전 월(2024-03)은 칠하지 않음
    expect(cell(back, 'E1')).toMatch(/보라색/);
  });
});
