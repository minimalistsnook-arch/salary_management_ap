import type { YearMonth } from './types';

const YM_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isYearMonth(v: unknown): v is YearMonth {
  return typeof v === 'string' && YM_RE.test(v);
}

export function toYearMonth(year: number, month: number): YearMonth {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function parseYearMonth(ym: YearMonth): { year: number; month: number } {
  const m = YM_RE.exec(ym);
  if (!m) throw new Error(`잘못된 연월 형식입니다: ${ym}`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** 연도 경계를 넘어가는 월 더하기: addMonths('2026-11', 2) === '2027-01' */
export function addMonths(ym: YearMonth, n: number): YearMonth {
  const { year, month } = parseYearMonth(ym);
  const idx = year * 12 + (month - 1) + n;
  return toYearMonth(Math.floor(idx / 12), (idx % 12) + 1);
}

export function compareMonths(a: YearMonth, b: YearMonth): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 'YYYY-MM-DD...' → 'YYYY-MM' */
export function monthOfDate(date: string): YearMonth {
  return date.slice(0, 7);
}

export function monthsOfYear(year: number): YearMonth[] {
  return Array.from({ length: 12 }, (_, i) => toYearMonth(year, i + 1));
}

/** 'YYYY-MM-DD' → 'M/D' (기존 Excel 표기 방식) */
export function shortDate(date: string): string {
  const [, m, d] = date.slice(0, 10).split('-');
  return `${Number(m)}/${Number(d)}`;
}

export function currentYearMonth(now: Date = new Date()): YearMonth {
  return toYearMonth(now.getFullYear(), now.getMonth() + 1);
}
