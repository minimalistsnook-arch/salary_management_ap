import { cellText, excelSerialToDateTime, parseAmountCell } from './excelValues';
import { addMonths, toYearMonth } from './month';
import type { YearMonth } from './types';

/**
 * 기존 '최종시트.xlsx' 의 '노무자문비' 시트 가져오기 (최초 1회 초기 데이터).
 * 구조: 거래처별 행 / 연도 → 월별 열 / 셀에 실제 입금 날짜 (예: 9/24, 여러 번이면 9/10, 9/24)
 */

export interface LegacyPayment {
  serviceMonth: YearMonth;
  paymentDates: string[]; // 'YYYY-MM-DD'
  rawCell: string;
}

export interface LegacyClientRow {
  excelRowNumber: number;
  name: string;
  contractAmount: number | null;
  payments: LegacyPayment[];
}

export interface LegacyParseResult {
  clients: LegacyClientRow[];
  errors: string[];
  warnings: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const t = (v: unknown) => cellText(v).normalize('NFKC').trim();

const MONTH_ONLY_RE = /^(\d{1,2})\s*월(분)?$/;
const YEAR_MONTH_RE = /^(\d{2}|\d{4})\s*[년.\-/]\s*(\d{1,2})\s*월?(분)?$/;
const YEAR_RE = /^(20\d{2})\s*년?(도)?$/;
const NAME_HEADER_RE = /거래처|회원사|업체|상호|회사명|사업장/;
const CONTRACT_HEADER_RE = /계약|자문료|월\s*금액|금액/;
const EMPTY_CELL_RE = /^(-|미납|x|X|없음)?$/;

/**
 * 'M/D' 의 연도 추정 규칙: 해당 월분의 시작일 기준 [-3개월, +9개월) 범위에 들어오는 연도.
 * (선납은 최대 3개월 전, 연체 입금은 최대 9개월 후까지로 본다)
 */
export function inferPaymentDate(serviceMonth: YearMonth, month: number, day: number): string | null {
  const from = addMonths(serviceMonth, -3);
  const to = addMonths(serviceMonth, 9);
  const baseYear = Number(serviceMonth.slice(0, 4));
  for (const y of [baseYear - 1, baseYear, baseYear + 1]) {
    const ym = toYearMonth(y, month);
    if (ym >= from && ym < to) {
      const last = new Date(Date.UTC(y, month, 0)).getUTCDate();
      if (day < 1 || day > last) return null;
      return `${y}-${pad(month)}-${pad(day)}`;
    }
  }
  return null;
}

function parsePaymentCell(v: unknown, serviceMonth: YearMonth): { dates: string[]; problem: string | null } {
  if (v === null || v === undefined) return { dates: [], problem: null };
  if (v instanceof Date) {
    return { dates: [`${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`], problem: null };
  }
  if (typeof v === 'number') {
    const dt = excelSerialToDateTime(v);
    return dt ? { dates: [dt.slice(0, 10)], problem: null } : { dates: [], problem: `날짜가 아닌 숫자 '${v}'` };
  }
  const s = t(v);
  if (EMPTY_CELL_RE.test(s)) return { dates: [], problem: null };
  const dates: string[] = [];
  const full = [...s.matchAll(/(20\d{2})[-./](\d{1,2})[-./](\d{1,2})/g)];
  if (full.length) {
    for (const m of full) dates.push(`${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`);
    return { dates, problem: null };
  }
  const short = [...s.matchAll(/(\d{1,2})\s*[/.월]\s*(\d{1,2})\s*일?/g)];
  if (!short.length) return { dates: [], problem: `날짜를 읽을 수 없는 값 '${s}'` };
  for (const m of short) {
    const d = inferPaymentDate(serviceMonth, Number(m[1]), Number(m[2]));
    if (!d) return { dates: [], problem: `날짜를 읽을 수 없는 값 '${s}'` };
    dates.push(d);
  }
  return { dates, problem: null };
}

export function parseLegacyAdvisorySheet(rows: unknown[][], firstRowNumber = 1, fallbackStartYear?: number): LegacyParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1) 월 헤더 행 찾기
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const n = (rows[i] ?? []).filter((c) => MONTH_ONLY_RE.test(t(c)) || YEAR_MONTH_RE.test(t(c))).length;
    if (n >= 3) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    errors.push("월 헤더 행(예: '1월 | 2월 | 3월')을 찾을 수 없습니다. '노무자문비' 시트가 맞는지 확인해주세요.");
    return { clients: [], errors, warnings };
  }
  const header = rows[headerIdx] ?? [];

  // 2) 연도: 위쪽 행(병합셀)에서 찾아 오른쪽으로 전파
  const yearAbove: (number | null)[] = header.map(() => null);
  for (let up = 1; up <= 3 && headerIdx - up >= 0; up++) {
    const r = rows[headerIdx - up] ?? [];
    let cur: number | null = null;
    for (let c = 0; c < Math.max(r.length, header.length); c++) {
      const m = YEAR_RE.exec(t(r[c]));
      if (m) cur = Number(m[1]);
      if (cur !== null && yearAbove[c] === null) yearAbove[c] = cur;
    }
    if (yearAbove.some((y) => y !== null)) break;
  }

  const monthCols: { col: number; month: YearMonth }[] = [];
  let seqYear = fallbackStartYear ?? null;
  let prevMonth = 0;
  for (let c = 0; c < header.length; c++) {
    const cell = t(header[c]);
    const ym = YEAR_MONTH_RE.exec(cell);
    if (ym) {
      const y = ym[1].length === 2 ? 2000 + Number(ym[1]) : Number(ym[1]);
      const m = Number(ym[2]);
      if (m >= 1 && m <= 12) monthCols.push({ col: c, month: toYearMonth(y, m) });
      continue;
    }
    const mo = MONTH_ONLY_RE.exec(cell);
    if (!mo) continue;
    const m = Number(mo[1]);
    if (m < 1 || m > 12) continue;
    let y = yearAbove[c];
    if (y !== null) {
      // 같은 연도 라벨 아래에서 월이 줄어들면(12월 → 1월) 다음 연도
      const prev = monthCols[monthCols.length - 1];
      if (prev && yearAbove[prev.col] === y && m <= prevMonth) y = Number(prev.month.slice(0, 4)) + 1;
      else if (prev && Number(prev.month.slice(0, 4)) > y) y = Number(prev.month.slice(0, 4)) + (m <= prevMonth ? 1 : 0);
    } else {
      if (seqYear === null) {
        errors.push(`${cell} 열(Excel ${firstRowNumber + headerIdx}행)의 연도를 알 수 없습니다. 시작 연도를 지정해주세요.`);
        return { clients: [], errors, warnings };
      }
      if (prevMonth && m <= prevMonth) seqYear++;
      y = seqYear;
    }
    prevMonth = m;
    monthCols.push({ col: c, month: toYearMonth(y, m) });
  }

  // 3) 거래처명 / 계약금액 열
  const firstMonthCol = Math.min(...monthCols.map((m) => m.col));
  const headerZone = rows.slice(Math.max(0, headerIdx - 3), headerIdx + 1);
  const findCol = (re: RegExp) => {
    for (let c = 0; c < firstMonthCol; c++) if (headerZone.some((r) => re.test(t((r ?? [])[c])))) return c;
    return -1;
  };
  let nameCol = findCol(NAME_HEADER_RE);
  const contractCol = findCol(CONTRACT_HEADER_RE);
  if (nameCol < 0) {
    // 헤더명이 없으면 월 열 왼쪽에서 문자가 가장 많은 열
    let best = -1;
    let bestCount = 0;
    for (let c = 0; c < firstMonthCol; c++) {
      if (c === contractCol) continue;
      const cnt = rows.slice(headerIdx + 1).filter((r) => /\p{L}/u.test(t((r ?? [])[c]))).length;
      if (cnt > bestCount) {
        best = c;
        bestCount = cnt;
      }
    }
    nameCol = best;
  }
  if (nameCol < 0) {
    errors.push("거래처명 열('거래처' 또는 '회원사')을 찾을 수 없습니다.");
    return { clients: [], errors, warnings };
  }

  // 4) 거래처 행
  const clients: LegacyClientRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const excelRow = firstRowNumber + i;
    const name = cellText(r[nameCol]).trim();
    if (!name || /^(합계|총계|소계|계)$/.test(name.replace(/\s/g, ''))) continue;
    if (MONTH_ONLY_RE.test(t(r[monthCols[0].col]))) continue; // 반복 헤더

    let contractAmount: number | null = null;
    if (contractCol >= 0) {
      const a = parseAmountCell(r[contractCol]);
      if (a.ok && a.value > 0) contractAmount = a.value;
      else if (!a.ok) warnings.push(`Excel ${excelRow}행 '${name}': 계약금액 '${cellText(r[contractCol])}'을 읽을 수 없습니다.`);
    }
    const payments: LegacyPayment[] = [];
    for (const mc of monthCols) {
      const { dates, problem } = parsePaymentCell(r[mc.col], mc.month);
      if (problem) warnings.push(`Excel ${excelRow}행 '${name}' ${mc.month}: ${problem} — 가져오지 않습니다.`);
      if (dates.length) payments.push({ serviceMonth: mc.month, paymentDates: dates, rawCell: cellText(r[mc.col]) });
    }
    clients.push({ excelRowNumber: excelRow, name, contractAmount, payments });
  }
  if (!clients.length) errors.push('거래처 데이터 행을 찾을 수 없습니다.');
  return { clients, errors, warnings };
}
