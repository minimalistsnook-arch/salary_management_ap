import { parseWon } from './money';
import { addMonths, toYearMonth } from './month';
import type { YearMonth } from './types';

/**
 * 회원사별 '마지막 입금' 기준표 (엑셀에서 복사해 붙여넣은 표)
 * 연번 | 회원사 | 계약금액 | 계약형태 | 입금예상일 | N월분 | 입금일(MM/DD) | 담당
 * 예) 1    세인트팩㈜    110,000    CMS    20    8월분    08/21    민주
 */
export interface BaselineRow {
  line: number;
  seq: string;
  name: string;
  contractAmount: number | null;
  contractType: string | null;
  expectedPayDay: string | null;
  /** 마지막으로 입금된 월분 (없으면 '입금기록 없음') */
  lastMonth: YearMonth | null;
  lastDate: string | null; // YYYY-MM-DD
  manager: string | null;
  rawMonth: string;
}

export interface BaselineParseResult {
  rows: BaselineRow[];
  errors: string[];
}

const AMOUNT_RE = /^(\d{1,3}(,\d{3})+|\d{4,})$/;
const MONTH_RE = /^(\d{1,2})\s*월분?$/;
const DATE_RE = /^(\d{1,2})[/.-](\d{1,2})$/;
const pad = (n: number) => String(n).padStart(2, '0');

/** 'MM/DD' → 기준일 이전 가장 최근 날짜 */
export function resolvePayDate(month: number, day: number, reference: string): string | null {
  const refYear = Number(reference.slice(0, 4));
  for (const y of [refYear, refYear - 1]) {
    const last = new Date(Date.UTC(y, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > last) return null;
    const d = `${y}-${pad(month)}-${pad(day)}`;
    if (d <= reference) return d;
  }
  return null;
}

/** 'N월분' 의 연도: 입금월 기준 3개월 선납 ~ 11개월 연체 범위 */
export function resolveServiceMonth(month: number, payDate: string): YearMonth | null {
  if (month < 1 || month > 12) return null;
  const payMonth = payDate.slice(0, 7);
  const y = Number(payDate.slice(0, 4));
  for (const cand of [y, y - 1, y + 1]) {
    const ym = toYearMonth(cand, month);
    if (ym >= addMonths(payMonth, -11) && ym <= addMonths(payMonth, 3)) return ym;
  }
  return null;
}

export function parseBaselineTable(text: string, reference: string): BaselineParseResult {
  const rows: BaselineRow[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = i + 1;
    if (!rawLine.trim()) return;
    // 탭 또는 2칸 이상 공백으로 구분
    const tokens = rawLine.split(/\t|\s{2,}/).map((s) => s.trim()).filter((s) => s !== '');
    if (tokens.length < 5 || !/^\d+$/.test(tokens[0])) {
      if (!/연번|회원사/.test(rawLine)) errors.push(`${line}행: 형식을 읽을 수 없습니다 — '${rawLine.trim().slice(0, 40)}'`);
      return;
    }
    const amountIdx = tokens.findIndex((t, idx) => idx >= 2 && AMOUNT_RE.test(t));
    if (amountIdx < 0) {
      errors.push(`${line}행: 계약금액을 찾을 수 없습니다.`);
      return;
    }
    const name = tokens.slice(1, amountIdx).join(' ').replace(/\s+/g, ' ').trim();
    const rest = tokens.slice(amountIdx + 1);
    const contractType = rest[0] ?? null;
    const expectedPayDay = rest[1] ?? null;
    let monthTok = rest[2] ?? '';
    let dateTok = rest[3] ?? '';
    let manager: string | null = rest[4] ?? null;
    if (!DATE_RE.test(dateTok)) {
      // 입금일이 비어 있는 경우 (예: '입금기록 없음')
      manager = dateTok || null;
      dateTok = '';
    }
    monthTok = monthTok.replace(/\s/g, '');
    const mm = MONTH_RE.exec(monthTok);
    const dm = DATE_RE.exec(dateTok);
    let lastDate: string | null = null;
    let lastMonth: YearMonth | null = null;
    if (mm && dm) {
      lastDate = resolvePayDate(Number(dm[1]), Number(dm[2]), reference);
      lastMonth = lastDate ? resolveServiceMonth(Number(mm[1]), lastDate) : null;
      if (!lastDate || !lastMonth) errors.push(`${line}행 '${name}': 월분/입금일(${monthTok} ${dateTok})을 해석할 수 없습니다.`);
    }
    rows.push({
      line,
      seq: tokens[0],
      name,
      contractAmount: parseWon(tokens[amountIdx]),
      contractType,
      expectedPayDay,
      lastMonth,
      lastDate,
      manager,
      rawMonth: monthTok,
    });
  });
  if (!rows.length && !errors.length) errors.push('읽을 수 있는 행이 없습니다.');
  return { rows, errors };
}
