import type { MatchStatus, MatchType, PaymentStatus } from './types';

import type { TransactionRow } from './dto';

/** 거래처로 확정되지 않은 입금 → '3. 개별건' 에서 관리 (1번 메뉴에는 표시하지 않음) */
export const isIndividualCase = (t: Pick<TransactionRow, 'deposit_amount' | 'match_status' | 'category'>) =>
  t.deposit_amount > 0 && t.category !== 'DUPLICATE' && (t.match_status === 'UNMATCHED' || t.match_status === 'REVIEW_REQUIRED');

/** 통장 중복 행 (건너뜀) — 어느 메뉴에도 표시하지 않음 */
export const isSkippedDuplicate = (t: Pick<TransactionRow, 'category'>) => t.category === 'DUPLICATE';

export const MATCH_STATUS_LABEL: Record<MatchStatus, string> = {
  AUTO_MATCHED: '자동매칭',
  MANUAL_MATCHED: '수동확정',
  REVIEW_REQUIRED: '확인필요',
  UNMATCHED: '미매칭',
};

export const MATCH_TYPE_LABEL: Record<MatchType, string> = {
  EXACT: '정확일치',
  FUZZY: '유사 매칭',
  ALIAS: '별칭',
  MANUAL: '수동',
  NONE: '-',
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  UNPAID: '미납',
  PARTIAL: '부분납',
  PAID: '완납',
};
