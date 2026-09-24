import { describe, expect, test } from 'vitest';
import { allocatePayment, applyToLedger, buildLedger, oldestUnpaidMonth, type Ledger } from './allocation';
import { feeWarning } from './feeCheck';
import { addMonths } from './month';

const empty = (): Ledger => new Map();
const simple = (lines: { serviceMonth: string; amount: number; status: string }[]) => lines.map((l) => [l.serviceMonth, l.amount, l.status]);

describe('계약금액 기준 월분 자동 배정', () => {
  test('CASE 1: 220,000 계약 / 440,000 입금 / 미납 시작 2026-05 → 5·6월 완납', () => {
    const r = allocatePayment({ amount: 440000, contractAmount: 220000, startMonth: '2026-05', ledger: empty() });
    expect(simple(r.lines)).toEqual([
      ['2026-05', 220000, 'PAID'],
      ['2026-06', 220000, 'PAID'],
    ]);
    expect(r.unallocated).toBe(0);
  });

  test('CASE 2: 660,000 입금 → 3개월 완납', () => {
    const r = allocatePayment({ amount: 660000, contractAmount: 220000, startMonth: '2026-05', ledger: empty() });
    expect(r.lines).toHaveLength(3);
    expect(r.lines.every((l) => l.status === 'PAID' && l.amount === 220000)).toBe(true);
    expect(r.lines.map((l) => l.serviceMonth)).toEqual(['2026-05', '2026-06', '2026-07']);
  });

  test('CASE 3: 330,000 입금 → 첫 달 완납, 다음 달 110,000 부분납', () => {
    const r = allocatePayment({ amount: 330000, contractAmount: 220000, startMonth: '2026-05', ledger: empty() });
    expect(simple(r.lines)).toEqual([
      ['2026-05', 220000, 'PAID'],
      ['2026-06', 110000, 'PARTIAL'],
    ]);
  });

  test('CASE 7: 2026-11 부터 3개월분 → 연도 넘어가기', () => {
    const r = allocatePayment({ amount: 660000, contractAmount: 220000, startMonth: '2026-11', ledger: empty() });
    expect(r.lines.map((l) => l.serviceMonth)).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2027-01', -1)).toBe('2026-12');
  });

  test('CASE 8: 5월 부분납 110,000 존재 + 새 입금 110,000 → 5월 합계 220,000 완납', () => {
    const ledger = buildLedger([{ service_month: '2026-05', allocated_amount: 110000, contract_amount_snapshot: 220000 }]);
    const r = allocatePayment({ amount: 110000, contractAmount: 220000, startMonth: '2026-05', ledger });
    expect(r.lines).toEqual([{ serviceMonth: '2026-05', amount: 110000, contractSnapshot: 220000, monthPaidAfter: 220000, status: 'PAID' }]);
  });

  test('이미 완납된 월(8월)은 건너뛰고 가장 오래된 미납월부터 배정', () => {
    const ledger = buildLedger([{ service_month: '2026-08', allocated_amount: 220000, contract_amount_snapshot: 220000 }]);
    const r = allocatePayment({ amount: 880000, contractAmount: 220000, startMonth: '2026-05', ledger });
    expect(r.lines.map((l) => l.serviceMonth)).toEqual(['2026-05', '2026-06', '2026-07', '2026-09']);
    expect(oldestUnpaidMonth('2026-05', ledger, 220000)).toBe('2026-05');
  });

  test('계약금액 변경: 기존 부분납 월은 당시 계약금액(snapshot) 기준으로 잔액만 채움', () => {
    const ledger = buildLedger([{ service_month: '2026-05', allocated_amount: 110000, contract_amount_snapshot: 220000 }]);
    const r = allocatePayment({ amount: 385000, contractAmount: 275000, startMonth: '2026-05', ledger });
    expect(r.lines.map((l) => [l.serviceMonth, l.amount, l.contractSnapshot, l.status])).toEqual([
      ['2026-05', 110000, 220000, 'PAID'],
      ['2026-06', 275000, 275000, 'PAID'],
    ]);
  });

  test('같은 업로드 안의 두 입금을 순차 반영', () => {
    const ledger = empty();
    const a = allocatePayment({ amount: 330000, contractAmount: 220000, startMonth: '2026-05', ledger });
    applyToLedger(ledger, a.lines);
    const b = allocatePayment({ amount: 110000, contractAmount: 220000, startMonth: '2026-05', ledger });
    expect(simple(b.lines)).toEqual([['2026-06', 110000, 'PAID']]);
  });

  test('금액은 정수 원 단위만 허용', () => {
    expect(() => allocatePayment({ amount: 220000.5, contractAmount: 220000, startMonth: '2026-05', ledger: empty() })).toThrow();
    expect(() => allocatePayment({ amount: 220000, contractAmount: 0, startMonth: '2026-05', ledger: empty() })).toThrow();
  });
});

describe('수수료 차감 가능성 경고', () => {
  test('계약 220,000 / 입금 219,725 → 경고', () => {
    expect(feeWarning(219725, 220000)).toMatch(/수수료 차감 가능성/);
    expect(feeWarning(439450, 220000)).toMatch(/수수료/);
  });
  test('정확한 배수 또는 명확한 부분납은 경고 없음', () => {
    expect(feeWarning(440000, 220000)).toBeNull();
    expect(feeWarning(330000, 220000)).toBeNull();
    expect(feeWarning(110000, 220000)).toBeNull();
  });
});
