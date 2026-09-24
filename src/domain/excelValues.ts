/** Excel 셀 값 변환 (라이브러리 독립, 순수 함수) */

const pad = (n: number) => String(n).padStart(2, '0');

function validYmd(y: number, m: number, d: number): boolean {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Excel 날짜 serial → 'YYYY-MM-DD HH:mm:ss' */
export function excelSerialToDateTime(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial * 86400) * 1000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const DT_RE = /^\s*(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/;
const DT_COMPACT_RE = /^\s*(\d{4})(\d{2})(\d{2})(?:\s*(\d{2}):?(\d{2}):?(\d{2})?)?\s*$/;

/** 통장 거래일시 셀 → 'YYYY-MM-DD HH:mm:ss' (알 수 없으면 null) */
export function parseDateTimeCell(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
  }
  if (typeof v === 'number') return excelSerialToDateTime(v);
  const s = String(v);
  const m = DT_RE.exec(s) ?? DT_COMPACT_RE.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!validYmd(y, mo, d)) return null;
  const hh = Number(m[4] ?? 0);
  const mi = Number(m[5] ?? 0);
  const ss = Number(m[6] ?? 0);
  if (hh > 23 || mi > 59 || ss > 59) return null;
  return `${y}-${pad(mo)}-${pad(d)} ${pad(hh)}:${pad(mi)}:${pad(ss)}`;
}

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export type AmountParse = { ok: true; value: number } | { ok: false; reason: string };

/** 금액 셀: 빈칸=0, 콤마 허용, 정수만 */
export function parseAmountCell(v: unknown): AmountParse {
  if (v === null || v === undefined) return { ok: true, value: 0 };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { ok: false, reason: '숫자가 아닌 값' };
    if (!Number.isInteger(v)) return { ok: false, reason: '원 단위 정수가 아닌 값' };
    if (v < 0) return { ok: false, reason: '음수 값' };
    if (!Number.isSafeInteger(v)) return { ok: false, reason: '너무 큰 값' };
    return { ok: true, value: v };
  }
  const s = String(v).replace(/[,\s원₩]/g, '');
  if (s === '' || s === '-') return { ok: true, value: 0 };
  if (/^-\d+$/.test(s)) return { ok: false, reason: '음수 값' };
  if (/^\d+\.\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isInteger(n)) return { ok: true, value: n };
    return { ok: false, reason: '원 단위 정수가 아닌 값' };
  }
  if (!/^\d+$/.test(s)) return { ok: false, reason: '숫자가 아닌 값' };
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return { ok: false, reason: '너무 큰 값' };
  return { ok: true, value: n };
}
