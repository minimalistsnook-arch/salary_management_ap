import { assertWon } from './money';
import { addMonths, compareMonths, isYearMonth } from './month';
import type { PaymentStatus, YearMonth } from './types';

/** 월별 기존 납부 현황. snapshot 은 해당 월 첫 배정 당시 계약금액 */
export interface LedgerMonth {
  paid: number;
  snapshot: number;
}
export type Ledger = Map<YearMonth, LedgerMonth>;

export interface AllocationLine {
  serviceMonth: YearMonth;
  amount: number;
  contractSnapshot: number;
  /** 이 배정 후 해당 월의 누적 납부액 */
  monthPaidAfter: number;
  status: PaymentStatus;
}

export interface AllocationResult {
  lines: AllocationLine[];
  /** 배정하지 못한 잔액 (최대 개월 수 초과 등) */
  unallocated: number;
}

export interface AllocationInput {
  amount: number;
  /** 현재 월 계약금액 (기존 배정이 없는 월에만 사용) */
  contractAmount: number;
  /** 배정 탐색 시작월 (관리 시작월 또는 사용자가 지정한 첫 적용월) */
  startMonth: YearMonth;
  ledger: Ledger;
  maxMonths?: number;
}

export function monthStatus(paid: number, due: number): PaymentStatus {
  if (paid <= 0) return 'UNPAID';
  return paid >= due ? 'PAID' : 'PARTIAL';
}

/**
 * 계약금액 기준 월분 자동 배정.
 * 입금일과 무관하게 startMonth 이후 가장 오래된 미납/부분납 월부터 순서대로 채운다.
 * 이미 기존 배정이 있는 월은 그 당시 계약금액(snapshot)을 기준으로 잔액만 채운다.
 */
export function allocatePayment(input: AllocationInput): AllocationResult {
  const amount = assertWon(input.amount, '입금액');
  const contract = assertWon(input.contractAmount, '계약금액');
  if (!isYearMonth(input.startMonth)) throw new Error(`첫 적용월 형식이 잘못되었습니다: ${input.startMonth}`);
  if (contract <= 0) throw new Error('월 계약금액이 0원이라 자동 배정할 수 없습니다.');
  const maxMonths = input.maxMonths ?? 240;

  const lines: AllocationLine[] = [];
  let left = amount;
  let month = input.startMonth;
  for (let i = 0; i < maxMonths && left > 0; i++, month = addMonths(month, 1)) {
    const existing = input.ledger.get(month);
    const due = existing ? existing.snapshot : contract;
    const paid = existing ? existing.paid : 0;
    const remaining = due - paid;
    if (remaining <= 0) continue; // 이미 완납된 월은 건너뜀
    const take = Math.min(remaining, left);
    left -= take;
    lines.push({
      serviceMonth: month,
      amount: take,
      contractSnapshot: due,
      monthPaidAfter: paid + take,
      status: monthStatus(paid + take, due),
    });
  }
  return { lines, unallocated: left };
}

/** 배정 결과를 ledger 에 반영 (같은 업로드 내 여러 입금 순차 시뮬레이션용) */
export function applyToLedger(ledger: Ledger, lines: { serviceMonth: YearMonth; amount: number; contractSnapshot: number }[]): void {
  for (const l of lines) {
    const cur = ledger.get(l.serviceMonth);
    if (cur) cur.paid += l.amount;
    else ledger.set(l.serviceMonth, { paid: l.amount, snapshot: l.contractSnapshot });
  }
}

/** DB 배정 행들로 ledger 생성. snapshot 은 해당 월 가장 먼저 생성된 배정의 값 */
export function buildLedger(
  rows: { service_month: YearMonth; allocated_amount: number; contract_amount_snapshot: number }[],
): Ledger {
  const ledger: Ledger = new Map();
  for (const r of rows) {
    const cur = ledger.get(r.service_month);
    if (cur) cur.paid += r.allocated_amount;
    else ledger.set(r.service_month, { paid: r.allocated_amount, snapshot: r.contract_amount_snapshot });
  }
  return ledger;
}

/** 관리 시작월 이후 가장 오래된 미납(또는 부분납) 월 */
export function oldestUnpaidMonth(startMonth: YearMonth, ledger: Ledger, contractAmount: number, maxMonths = 240): YearMonth {
  let month = startMonth;
  for (let i = 0; i < maxMonths; i++, month = addMonths(month, 1)) {
    const e = ledger.get(month);
    const due = e ? e.snapshot : contractAmount;
    if (!e || e.paid < due) return month;
  }
  return month;
}

/** 배정 탐색 시작월 결정. 관리 시작월도 기존 배정도 없으면 null (= 월 배정 필요) */
export function resolveStartMonth(opts: {
  overrideMonth?: YearMonth | null;
  managementStartMonth: YearMonth | null;
  ledger: Ledger;
}): YearMonth | null {
  if (opts.overrideMonth) return opts.overrideMonth;
  if (opts.managementStartMonth) return opts.managementStartMonth;
  // 관리 시작월이 없더라도 기존 배정 기록이 있으면 가장 이른 기록월부터
  const months = [...opts.ledger.keys()].sort(compareMonths);
  return months[0] ?? null;
}
