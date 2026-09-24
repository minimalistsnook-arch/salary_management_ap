/** 모든 금액은 원 단위 정수. 부동소수 금액을 허용하지 않는다. */
export function assertWon(v: number, label = '금액'): number {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new Error(`${label}은(는) 0 이상의 정수(원)여야 합니다: ${v}`);
  }
  return v;
}

export function formatWon(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  return v.toLocaleString('ko-KR');
}

/** '1,100,000' / '220000' / 220000 → 220000. 정수가 아니면 null */
export function parseWon(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  const s = String(v).replace(/[,\s원₩]/g, '');
  if (s === '') return null;
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
