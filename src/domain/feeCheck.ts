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
