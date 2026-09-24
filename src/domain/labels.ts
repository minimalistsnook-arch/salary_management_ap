import type { MatchStatus, MatchType, PaymentStatus } from './types';

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
