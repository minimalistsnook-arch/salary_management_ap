/** 이 개월 수 이상을 한 번에 입금하면 다른 수수료 포함 여부 확인 */
export const LARGE_DEPOSIT_MONTHS = 4;

/** 계약금액의 여러 배 입금 (선납 또는 급여관리/개별건 수수료가 섞였을 가능성) — 경고만 */
export function largeDepositWarning(amount: number, contractAmount: number): string | null {
  if (contractAmount <= 0 || amount < contractAmount * LARGE_DEPOSIT_MONTHS) return null;
  return `계약금액의 약 ${Math.floor(amount / contractAmount)}개월분 — 선납인지, 다른 수수료가 포함됐는지 확인`;
}

/**
 * 계약금액과 입금액의 작은 차이를 경고만 한다. (자동 보정하지 않음)
 * 허용 오차: 계약금액의 5% 또는 1,000원 중 큰 값
 */
export function feeWarning(amount: number, contractAmount: number): string | null {
  if (contractAmount <= 0 || amount <= 0) return null;
  const rem = amount % contractAmount;
  if (rem === 0) return null;
  const tolerance = Math.max(1000, Math.floor((contractAmount * 5) / 100));
  const shortfall = contractAmount - rem;
  if (shortfall <= tolerance) {
    return `계약금액 배수보다 ${shortfall.toLocaleString('ko-KR')}원 부족 — 수수료 차감 가능성`;
  }
  if (amount > contractAmount && rem <= tolerance) {
    return `계약금액 배수보다 ${rem.toLocaleString('ko-KR')}원 초과 — 확인 필요`;
  }
  return null;
}
