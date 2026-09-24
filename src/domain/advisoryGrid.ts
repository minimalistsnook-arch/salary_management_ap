import { monthStatus } from './allocation';
import { addMonths, compareMonths, monthsOfYear } from './month';
import type { AllocationSource, YearMonth } from './types';

/** 노무자문비 월 셀 상태. NOT_MANAGED = 관리 시작 전 / 시작월 미지정 */
export type CellState = 'PAID' | 'PARTIAL' | 'UNPAID' | 'FUTURE' | 'NOT_MANAGED';

export interface GridClient {
  id: number;
  name: string;
  current_contract_amount: number;
  management_start_month: YearMonth | null;
}

export interface GridAllocation {
  id: number;
  client_id: number;
  transaction_id: number | null;
  service_month: YearMonth;
  payment_date: string;
  allocated_amount: number;
  contract_amount_snapshot: number;
  source: AllocationSource;
}

export interface MonthCell {
  month: YearMonth;
  state: CellState;
  due: number;
  paid: number;
  payments: GridAllocation[];
}

export interface ClientYearRow {
  client: GridClient;
  effectiveStart: YearMonth | null;
  cells: MonthCell[];
  annualDue: number;
  annualPaid: number;
  receivable: number;
  hasUnpaid: boolean;
  hasPartial: boolean;
  isFullyPaid: boolean;
}

function byMonth(allocs: GridAllocation[]): Map<YearMonth, GridAllocation[]> {
  const map = new Map<YearMonth, GridAllocation[]>();
  for (const a of [...allocs].sort((x, y) => x.id - y.id)) {
    const list = map.get(a.service_month) ?? [];
    list.push(a);
    map.set(a.service_month, list);
  }
  return map;
}

export function effectiveStartMonth(client: GridClient, allocs: GridAllocation[]): YearMonth | null {
  if (client.management_start_month) return client.management_start_month;
  const months = allocs.map((a) => a.service_month).sort(compareMonths);
  return months[0] ?? null;
}

export function buildMonthCell(
  client: GridClient,
  month: YearMonth,
  monthAllocs: GridAllocation[],
  start: YearMonth | null,
  currentMonth: YearMonth,
): MonthCell {
  const paid = monthAllocs.reduce((s, a) => s + a.allocated_amount, 0);
  if (paid > 0) {
    const due = monthAllocs[0].contract_amount_snapshot;
    return { month, state: monthStatus(paid, due), due, paid, payments: monthAllocs };
  }
  if (!start || month < start || client.current_contract_amount <= 0) {
    return { month, state: 'NOT_MANAGED', due: 0, paid: 0, payments: [] };
  }
  return { month, state: month > currentMonth ? 'FUTURE' : 'UNPAID', due: client.current_contract_amount, paid: 0, payments: [] };
}

/** 거래처 1곳의 연간 12개월 행. allocs 는 해당 거래처의 전체 배정(연도 무관) */
export function buildClientYearRow(client: GridClient, allocs: GridAllocation[], year: number, currentMonth: YearMonth): ClientYearRow {
  const start = effectiveStartMonth(client, allocs);
  const grouped = byMonth(allocs);
  const cells = monthsOfYear(year).map((m) => buildMonthCell(client, m, grouped.get(m) ?? [], start, currentMonth));
  let annualDue = 0;
  let annualPaid = 0;
  let receivable = 0;
  for (const c of cells) {
    if (c.state !== 'NOT_MANAGED') annualDue += c.due;
    annualPaid += c.paid;
    if (c.month <= currentMonth && (c.state === 'UNPAID' || c.state === 'PARTIAL')) receivable += c.due - c.paid;
  }
  const hasUnpaid = cells.some((c) => c.state === 'UNPAID');
  const hasPartial = cells.some((c) => c.state === 'PARTIAL');
  const managed = cells.some((c) => c.state !== 'NOT_MANAGED');
  return { client, effectiveStart: start, cells, annualDue, annualPaid, receivable, hasUnpaid, hasPartial, isFullyPaid: managed && receivable === 0 && !hasPartial };
}

/** 관리 시작월부터 현재월까지 미납/부분납 월 목록 (연도 무관) */
export function outstandingMonths(client: GridClient, allocs: GridAllocation[], currentMonth: YearMonth, maxMonths = 240): MonthCell[] {
  const start = effectiveStartMonth(client, allocs);
  if (!start) return [];
  const grouped = byMonth(allocs);
  const out: MonthCell[] = [];
  let m = start;
  for (let i = 0; i < maxMonths && m <= currentMonth; i++, m = addMonths(m, 1)) {
    const cell = buildMonthCell(client, m, grouped.get(m) ?? [], start, currentMonth);
    if (cell.state === 'UNPAID' || cell.state === 'PARTIAL') out.push(cell);
  }
  return out;
}
