/**
 * 거래처명 정규화.
 * 비교 전용 값이며, 원본 거래처명/통장 표기명은 절대 변경하지 않는다.
 */

// 법인 표시(NFKC 이후 ㈜ → (주) 로 변환됨)
const CORP_WORDS = [
  '농업회사법인',
  '주식회사',
  '유한회사',
  '유한책임회사',
  '합자회사',
  '합명회사',
  '재단법인',
  '사단법인',
  '의료법인',
  '사회복지법인',
];
const CORP_PAREN_RE = /\((주|유|재|사|합|의|복)\)/g;
// 괄호가 한쪽만 남은 표기: '주)광일운수', '광일운수(주'
const CORP_HALF_RE = /^(주|유)\)|\((주|유)$/g;

export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw).normalize('NFKC').toLowerCase().trim();
  s = s.replace(/\s+/g, ' ');
  s = s.replace(CORP_PAREN_RE, ' ');
  for (const w of CORP_WORDS) s = s.split(w).join(' ');
  s = s.trim().replace(CORP_HALF_RE, ' ');
  // 공백·구두점 제거 (문자/숫자만 남김)
  return s.replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * 여러 거래처가 공통으로 쓰는 입금명. 특정 거래처로 자동 매칭하거나 alias로 저장하지 않는다.
 */
export const GENERIC_SENDER_NAMES = [
  'cms집금',
  'cms',
  '집금',
  '카드결제',
  '카드밴넷',
  '카드대금',
  '입금',
  '자동이체',
  '이체',
  '타행이체',
  '당행이체',
  '인터넷이체',
  '모바일이체',
  '무통장',
  '무통장입금',
  '현금',
  '현금입금',
  '대체',
  '이자',
  '결산이자',
  '예금이자',
  '펌뱅킹',
  '가상계좌',
  '급여',
  '환불',
  // 은행명 단독 표기
  '신한',
  '국민',
  '우리',
  '하나',
  '농협',
  '기업',
  '수협',
  '신협',
  '새마을',
  '우체국',
  '카카오',
  '토스',
  '케이뱅크',
  '카카오뱅크',
  '토스뱅크',
];

const GENERIC_SET = new Set(GENERIC_SENDER_NAMES.map((n) => normalizeName(n)));
const GENERIC_PREFIX_RE = /^(cms|카드|펌뱅킹|가상계좌)/;

export function isGenericSender(raw: string | null | undefined): boolean {
  const n = normalizeName(raw);
  if (!n) return true;
  return GENERIC_SET.has(n) || GENERIC_PREFIX_RE.test(n);
}

/** 수동 확정한 통장 표기명을 alias로 저장해도 되는가 */
export function canLearnAlias(raw: string | null | undefined): boolean {
  return !isGenericSender(raw) && normalizeName(raw).length >= 2;
}
