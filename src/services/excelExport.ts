import type * as XLSXTypes from 'xlsx';
import type { GridAllocation } from '../domain/advisoryGrid';
import type { ExportResponse, TransactionRow } from '../domain/dto';
import { normalizeName } from '../domain/normalize';
import { shortDate } from '../domain/month';
import type { Client } from '../domain/types';

/**
 * 전체 Excel 추출 (업무 양식)
 * 1. 입출금내역 : 1~3행 헤더, B~D열 '수입' (입금일 · 적요 · 수입금액)
 * 2. 급여관리   : 번호 · 이름(회사명 + 월) · 공급가액 · 부가세 · 입금일 · 입금액
 * 3. 개별건     : 번호 · 상호 · 공급가액 · 부가세 · 입금일 · 입금액
 * 4. 노무자문비 : 기존 '[ 매 출 ]-회원사' 양식 (2행 연도, 3행 월, 각 행에 입금일), 거래처별 마지막 입금월 셀은 보라색
 * 셀 색을 저장하기 위해 추출은 xlsx-js-style(SheetJS 호환 + 스타일)로 쓴다. 파일 읽기는 SheetJS 그대로.
 */

type Cell = string | number | null;
type XLSX = typeof XLSXTypes;

export interface IncomeRow {
  date: string; // YYYY-MM-DD
  memo: string; // 적요
  amount: number;
}

/** 원 단위 부가세 분리: 공급가액 = 입금액 / 1.1 (반올림), 부가세 = 입금액 - 공급가액 */
export function splitVat(amount: number): { supply: number; vat: number } {
  const supply = Math.round((amount * 10) / 11);
  return { supply, vat: amount - supply };
}

/** '청담웨딩프라자 8월' — 입금 연도와 적용 연도가 다르면 '25년 12월' */
export function monthMemo(clientName: string, serviceMonth: string, paymentDate: string): string {
  const [y, m] = serviceMonth.split('-');
  const label = y === paymentDate.slice(0, 4) ? `${Number(m)}월` : `${y.slice(2)}년 ${Number(m)}월`;
  return `${clientName} ${label}`;
}

const inYear = (date: string, year: number | null) => year === null || date.startsWith(String(year));

/** 입출금내역 수입 행: 자문료 배정은 월별로 나누고, 배정되지 않은 입금은 통장 원본명으로 */
export function buildIncomeRows(transactions: TransactionRow[], year: number | null): IncomeRow[] {
  const rows: IncomeRow[] = [];
  const txs = transactions
    .filter((t) => t.deposit_amount > 0 && t.category !== 'DUPLICATE' && inYear(t.transaction_datetime, year))
    .sort((a, b) => a.transaction_datetime.localeCompare(b.transaction_datetime) || a.id - b.id);
  for (const t of txs) {
    const date = t.transaction_datetime.slice(0, 10);
    const allocs = [...t.allocations].sort((a, b) => a.service_month.localeCompare(b.service_month));
    let allocated = 0;
    for (const a of allocs) {
      rows.push({ date, memo: monthMemo(t.client_name ?? t.sender_raw, a.service_month, date), amount: a.allocated_amount });
      allocated += a.allocated_amount;
    }
    const rest = t.deposit_amount - allocated;
    if (rest > 0) rows.push({ date, memo: allocs.length ? `${t.client_name ?? t.sender_raw} (미배정)` : t.sender_raw, amount: rest });
  }
  return rows;
}

/** 자문료(거래처 확정) 입금만 — 급여관리 시트용 */
export function buildFeeRows(transactions: TransactionRow[], year: number | null): IncomeRow[] {
  return buildIncomeRows(
    transactions.filter((t) => t.allocations.length > 0),
    year,
  ).filter((r) => !r.memo.endsWith('(미배정)'));
}

// ---------- 셀/시트 유틸 ----------

function dateSerial(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
}

function setFormat(X: XLSX, ws: XLSXTypes.WorkSheet, r: number, c: number, z: string) {
  const cell = ws[X.utils.encode_cell({ r, c })];
  if (cell && typeof cell.v === 'number') cell.z = z;
}

/** 마지막 입금월 강조 (보라색) */
export const LAST_PAID_STYLE = {
  fill: { patternType: 'solid', fgColor: { rgb: 'C9A7F0' } },
  font: { bold: true, color: { rgb: '3B0764' } },
  alignment: { horizontal: 'center' },
};

function merge(s: [number, number], e: [number, number]): XLSXTypes.Range {
  return { s: { r: s[0], c: s[1] }, e: { r: e[0], c: e[1] } };
}

// ---------- 1. 입출금내역 ----------
function incomeSheet(X: XLSX, rows: IncomeRow[], title: string): XLSXTypes.WorkSheet {
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const aoa: Cell[][] = [
    [title, null, null, null],
    [null, '수입', null, null],
    [null, '입금일', '적요', '수입금액'],
    ...rows.map((r) => [null, dateSerial(r.date), r.memo, r.amount]),
    [null, '합계', null, total],
  ];
  const ws = X.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [merge([0, 0], [0, 3]), merge([1, 1], [1, 3])];
  ws['!cols'] = [{ wch: 3 }, { wch: 12 }, { wch: 34 }, { wch: 14 }];
  rows.forEach((_, i) => {
    setFormat(X, ws, 3 + i, 1, 'm"월" d"일"');
    setFormat(X, ws, 3 + i, 3, '#,##0');
  });
  setFormat(X, ws, 3 + rows.length, 3, '#,##0');
  ws['!freeze'] = { xSplit: 0, ySplit: 3 };
  return ws;
}

// ---------- 2·3. 급여관리 / 개별건 ----------
function vatSheet(X: XLSX, rows: { name: string; date: string; amount: number }[], nameHeader: string): XLSXTypes.WorkSheet {
  const body = rows.map((r, i) => {
    const { supply, vat } = splitVat(r.amount);
    return [i + 1, r.name, supply, vat, dateSerial(r.date), r.amount] as Cell[];
  });
  const sum = (k: number) => body.reduce((s, r) => s + (r[k] as number), 0);
  const aoa: Cell[][] = [['번호', nameHeader, '공급가액', '부가세', '입금일', '입금액'], ...body, [null, '합계', sum(2), sum(3), null, sum(5)]];
  const ws = X.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 6 }, { wch: 34 }, { wch: 13 }, { wch: 11 }, { wch: 12 }, { wch: 13 }];
  for (let i = 1; i <= body.length + 1; i++) {
    for (const c of [2, 3, 5]) setFormat(X, ws, i, c, '#,##0');
    setFormat(X, ws, i, 4, 'yyyy-mm-dd');
  }
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  return ws;
}

// ---------- 4. 노무자문비 ----------
export function advisoryLayout(clients: Client[], allocations: GridAllocation[], currentYear: number) {
  const years = allocations.map((a) => Number(a.service_month.slice(0, 4)));
  const firstYear = years.length ? Math.min(...years, currentYear) : currentYear;
  const lastYear = Math.max(currentYear, ...years);
  const yearList = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i);

  const byClient = new Map<number, GridAllocation[]>();
  for (const a of [...allocations].sort((x, y) => x.payment_date.localeCompare(y.payment_date) || x.id - y.id)) {
    byClient.set(a.client_id, [...(byClient.get(a.client_id) ?? []), a]);
  }
  // 연번 순서: 활성 거래처는 거래처 시트 행 순서, 비활성은 뒤에
  const withData = clients.filter((c) => c.active || byClient.has(c.id));
  const ordered = [...withData].sort(
    (a, b) => b.active - a.active || (a.source_row ?? 1e9) - (b.source_row ?? 1e9) || normalizeName(a.name).localeCompare(normalizeName(b.name), 'ko'),
  );
  return { yearList, byClient, ordered };
}

function advisorySheet(X: XLSX, clients: Client[], allocations: GridAllocation[], currentYear: number): XLSXTypes.WorkSheet {
  const { yearList, byClient, ordered } = advisoryLayout(clients, allocations, currentYear);
  const FIRST = 8; // I열
  const managerCol = FIRST + yearList.length * 12;

  const row1: Cell[] = ['[ 매 출 ]-회원사', null, null, null, '■ 보라색 = 거래처별 마지막 입금월'];
  const lastPaidCells: { r: number; c: number }[] = [];
  const row2: Cell[] = ['연번', '계약기간', null, null, '회     원     사', '계약금액', '계약형태', '입금예상일'];
  const row3: Cell[] = [null, null, null, null, null, null, null, null];
  yearList.forEach((y, i) => {
    row2[FIRST + i * 12] = i === 0 ? `${y} 년도` : `${y}년`;
    for (let m = 1; m <= 12; m++) row3[FIRST + i * 12 + m - 1] = `${m}월`;
  });
  row2[managerCol] = '담당';
  row3[managerCol] = null;

  const body: Cell[][] = ordered.map((c, idx) => {
    const r: Cell[] = [
      idx + 1,
      c.contract_start ?? null,
      c.contract_start || c.contract_end ? '~' : null,
      c.contract_end ?? null,
      c.name,
      c.current_contract_amount,
      c.contract_type ?? null,
      c.expected_pay_day ?? null,
    ];
    const months = new Map<string, string[]>();
    for (const a of byClient.get(c.id) ?? []) {
      const list = months.get(a.service_month) ?? [];
      const d = shortDate(a.payment_date);
      if (!list.includes(d)) list.push(d);
      months.set(a.service_month, list);
    }
    yearList.forEach((y, i) => {
      for (let m = 1; m <= 12; m++) {
        const dates = months.get(`${y}-${String(m).padStart(2, '0')}`);
        r[FIRST + i * 12 + m - 1] = dates ? dates.join(',') : null;
      }
    });
    // 입금이 있는 가장 마지막 월 (연도 무관)
    const last = [...months.keys()].sort().pop();
    if (last) {
      const yi = yearList.indexOf(Number(last.slice(0, 4)));
      if (yi >= 0) lastPaidCells.push({ r: 3 + idx, c: FIRST + yi * 12 + Number(last.slice(5, 7)) - 1 });
    }
    r[managerCol] = c.manager ?? null;
    return r;
  });

  const ws = X.utils.aoa_to_sheet([row1, row2, row3, ...body]);
  ws['!merges'] = [
    merge([1, 0], [2, 0]),
    merge([1, 1], [2, 3]),
    ...[4, 5, 6, 7].map((c) => merge([1, c], [2, c])),
    ...yearList.map((_, i) => merge([1, FIRST + i * 12], [1, FIRST + i * 12 + 11])),
    merge([1, managerCol], [2, managerCol]),
  ];
  ws['!cols'] = [
    { wch: 5 },
    { wch: 11 },
    { wch: 2 },
    { wch: 11 },
    { wch: 24 },
    { wch: 11 },
    { wch: 9 },
    { wch: 9 },
    ...Array(yearList.length * 12).fill({ wch: 7 }),
    { wch: 7 },
  ];
  body.forEach((_, i) => setFormat(X, ws, 3 + i, 5, '#,##0'));
  for (const { r, c } of lastPaidCells) {
    const cell = ws[X.utils.encode_cell({ r, c })];
    if (cell) (cell as XLSXTypes.CellObject & { s?: unknown }).s = LAST_PAID_STYLE;
  }
  const legend = ws['E1'] as (XLSXTypes.CellObject & { s?: unknown }) | undefined;
  if (legend) legend.s = { font: { bold: true, color: { rgb: '6B21A8' } } };
  ws['!freeze'] = { xSplit: FIRST, ySplit: 3 };
  return ws;
}

/** year: 입출금내역·급여관리·개별건의 입금일 기준 연도 (null = 전체). 노무자문비는 항상 전체 기간 */
export function buildWorkbook(X: XLSX, data: ExportResponse, year: number | null): XLSXTypes.WorkBook {
  const wb = X.utils.book_new();
  const title = year === null ? '입출금내역' : `입출금내역 (${year}년)`;
  X.utils.book_append_sheet(wb, incomeSheet(X, buildIncomeRows(data.transactions, year), title), '입출금내역');
  X.utils.book_append_sheet(
    wb,
    vatSheet(
      X,
      buildFeeRows(data.transactions, year).map((r) => ({ name: r.memo, date: r.date, amount: r.amount })),
      '이름',
    ),
    '급여관리',
  );
  X.utils.book_append_sheet(
    wb,
    vatSheet(
      X,
      data.individual
        .filter((t) => inYear(t.transaction_datetime, year))
        .sort((a, b) => a.transaction_datetime.localeCompare(b.transaction_datetime) || a.id - b.id)
        .map((t) => ({ name: t.sender_raw, date: t.transaction_datetime.slice(0, 10), amount: t.deposit_amount })),
      '상호',
    ),
    '개별건',
  );
  X.utils.book_append_sheet(wb, advisorySheet(X, data.clients, data.advisory.allocations, Number(data.currentMonth.slice(0, 4))), '노무자문비');
  return wb;
}

export async function downloadWorkbook(data: ExportResponse, year: number | null): Promise<string> {
  const mod = (await import('xlsx-js-style')) as unknown as XLSX & { default?: XLSX };
  const X = mod.default ?? mod;
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const filename = `노무자문관리_${year === null ? '전체' : `${year}년`}_${stamp}.xlsx`;
  X.writeFile(buildWorkbook(X, data, year), filename, { compression: true });
  return filename;
}
