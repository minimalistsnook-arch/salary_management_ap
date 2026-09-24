import { isGenericSender, normalizeName } from './normalize';
import type { MatchStatus, MatchType } from './types';

export const AUTO_MATCH_THRESHOLD = 70; // 70% 이상 → 자동 매칭 후보
export const AMBIGUITY_GAP = 5; // 1·2위 차이 5% 미만 → 수동 확인
export const REVIEW_FLOOR = 50; // 50~69% → 추천만 표시(확인필요), 그 미만 → 미매칭
export const INDIVIDUAL_SIMILAR_THRESHOLD = 40; // 개별건 중 유사 거래처 표시 기준

function levenshtein(a: string, b: string): number {
  const ac = [...a];
  const bc = [...b];
  let prev = Array.from({ length: bc.length + 1 }, (_, i) => i);
  for (let i = 1; i <= ac.length; i++) {
    const cur = [i];
    for (let j = 1; j <= bc.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ac[i - 1] === bc[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[bc.length];
}

function bigrams(s: string): string[] {
  const c = [...s];
  const out: string[] = [];
  for (let i = 0; i < c.length - 1; i++) out.push(c[i] + c[i + 1]);
  return out;
}

function dice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.length === 0 || B.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const g of B) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of A) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      hit++;
      pool.set(g, n - 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
}

/**
 * 정규화된 두 이름의 유사도 (0~100 정수, 내림).
 * 은행 통장 표기는 글자수 제한으로 앞부분만 남는 경우가 많아 접두 포함을 가산한다.
 */
export function similarityOfNormalized(na: string, nb: string): number {
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  const la = [...na].length;
  const lb = [...nb].length;
  const [short, long, ls, ll] = la <= lb ? [na, nb, la, lb] : [nb, na, lb, la];
  const lev = 1 - levenshtein(na, nb) / Math.max(la, lb);
  let contain = 0;
  if (ls >= 2) {
    if (long.startsWith(short)) contain = 0.6 + (0.4 * ls) / ll;
    else if (long.includes(short)) contain = 0.5 + (0.4 * ls) / ll;
  }
  const score = Math.max(lev, dice(na, nb), contain);
  return Math.min(99, Math.floor(score * 100 + 1e-9));
}

export function similarity(a: string, b: string): number {
  return similarityOfNormalized(normalizeName(a), normalizeName(b));
}

export interface MatchableClient {
  id: number;
  name: string;
}

export interface MatchCandidate {
  clientId: number;
  clientName: string;
  score: number;
  /** 거래처명(B열)이 아니라 시트 A열 표기와 비슷해서 나온 점수일 때, 그 A열 값 */
  viaAlias?: string;
}

export interface MatchResult {
  status: MatchStatus;
  matchType: MatchType;
  /** AUTO_MATCHED: 확정 후보, REVIEW_REQUIRED: 추천 거래처(없을 수 있음) */
  clientId: number | null;
  score: number;
  candidates: MatchCandidate[];
  reason: string | null;
  isGeneric: boolean;
}

export interface MatchIndex {
  /** sheetAliases: 거래처 마스터 시트 A열 표기 (유사도 비교에도 사용) */
  clients: { id: number; name: string; normalized: string; sheetAliases: { raw: string; normalized: string }[] }[];
  /** normalized_sender → client_id */
  aliases: Map<string, number>;
}

export interface IndexAlias {
  normalized_sender: string;
  client_id: number;
  raw_sender?: string;
  source?: 'MANUAL' | 'SHEET';
}

/**
 * 별칭 처리:
 * - 모든 별칭: 통장 표기와 정확히 같으면(정규화 기준) 해당 거래처로 매칭
 * - 시트 A열 별칭(SHEET): 비슷하기만 해도 B열 거래처 후보로 유사도 비교
 *   (수동 확정으로 학습된 별칭은 개인명 등이 많아 정확 일치만 사용)
 */
export function buildMatchIndex(clients: MatchableClient[], aliases: IndexAlias[]): MatchIndex {
  const sheetByClient = new Map<number, { raw: string; normalized: string }[]>();
  for (const a of aliases) {
    if (a.source !== 'SHEET' || !a.normalized_sender) continue;
    sheetByClient.set(a.client_id, [...(sheetByClient.get(a.client_id) ?? []), { raw: a.raw_sender ?? a.normalized_sender, normalized: a.normalized_sender }]);
  }
  return {
    clients: clients.map((c) => ({ id: c.id, name: c.name, normalized: normalizeName(c.name), sheetAliases: sheetByClient.get(c.id) ?? [] })),
    aliases: new Map(aliases.map((a) => [a.normalized_sender, a.client_id])),
  };
}

export function matchSender(senderRaw: string, index: MatchIndex): MatchResult {
  const normalized = normalizeName(senderRaw);
  if (!normalized) {
    return { status: 'UNMATCHED', matchType: 'NONE', clientId: null, score: 0, candidates: [], reason: '통장 표기명이 비어 있습니다.', isGeneric: false };
  }

  if (isGenericSender(senderRaw)) {
    return {
      status: 'REVIEW_REQUIRED',
      matchType: 'NONE',
      clientId: null,
      score: 0,
      candidates: [],
      reason: '공통 입금명(CMS집금 등)입니다. 거래처를 직접 선택해주세요.',
      isGeneric: true,
    };
  }

  // 거래처별 점수 = max(B열 거래처명 유사도, 시트 A열 표기 유사도)
  const scored: MatchCandidate[] = index.clients
    .map((c) => {
      const best: MatchCandidate = { clientId: c.id, clientName: c.name, score: similarityOfNormalized(normalized, c.normalized) };
      for (const al of c.sheetAliases) {
        const s = similarityOfNormalized(normalized, al.normalized);
        if (s > best.score) {
          best.score = s;
          best.viaAlias = al.raw;
        }
      }
      return best;
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.clientName.localeCompare(b.clientName, 'ko'));
  const candidates = scored.slice(0, 5);

  const aliasClientId = index.aliases.get(normalized);
  const aliasClient = aliasClientId !== undefined ? index.clients.find((c) => c.id === aliasClientId) : undefined;
  if (aliasClient) {
    return {
      status: 'AUTO_MATCHED',
      matchType: 'ALIAS',
      clientId: aliasClient.id,
      score: 100,
      candidates: [{ clientId: aliasClient.id, clientName: aliasClient.name, score: 100 }, ...candidates.filter((c) => c.clientId !== aliasClient.id)].slice(0, 5),
      reason: '등록된 별칭으로 매칭',
      isGeneric: false,
    };
  }

  const decided = classifyCandidates(scored);
  const via = scored[0]?.viaAlias;
  if (via && decided.clientId === scored[0].clientId) {
    const note = `시트 A열 '${via}'과(와) 유사 → B열 거래처`;
    decided.reason = decided.reason ? `${note} · ${decided.reason}` : note;
  }
  // 통장 표기가 여러 거래처명(또는 A열 표기)에 함께 포함되면(예: '청진' ⊂ 청진운수, 청진교통) 자동매칭하지 않는다
  if (decided.status === 'AUTO_MATCHED' && decided.score < 100) {
    const containing = index.clients.filter((c) => c.normalized.includes(normalized) || c.sheetAliases.some((a) => a.normalized.includes(normalized))).length;
    if (containing >= 2) {
      return { ...decided, status: 'REVIEW_REQUIRED', reason: `통장 표기가 거래처 ${containing}곳의 이름에 포함됩니다.`, candidates };
    }
  }
  return { ...decided, candidates };
}

/**
 * 유사도 순으로 정렬된 후보로 매칭 상태 결정.
 * - 1위 70% 이상 & 2위와 5% 이상 차이 → AUTO_MATCHED
 * - 1위 70% 이상이지만 2위와 차이 5% 미만 → REVIEW_REQUIRED
 * - 1위 50~69% → REVIEW_REQUIRED (추천만, 자동매칭 금지)
 * - 그 외 → UNMATCHED
 */
export function classifyCandidates(scored: MatchCandidate[]): Omit<MatchResult, 'candidates'> {
  const [top, second] = scored;
  if (!top || top.score < REVIEW_FLOOR) {
    return { status: 'UNMATCHED', matchType: 'NONE', clientId: null, score: top?.score ?? 0, reason: '유사한 거래처가 없습니다.', isGeneric: false };
  }
  if (top.score < AUTO_MATCH_THRESHOLD) {
    return { status: 'REVIEW_REQUIRED', matchType: 'FUZZY', clientId: top.clientId, score: top.score, reason: `유사도 ${AUTO_MATCH_THRESHOLD}% 미만 — 자동매칭 불가`, isGeneric: false };
  }
  if (second && top.score - second.score < AMBIGUITY_GAP) {
    return {
      status: 'REVIEW_REQUIRED',
      matchType: 'FUZZY',
      clientId: top.clientId,
      score: top.score,
      reason: `상위 후보 유사도 차이가 ${AMBIGUITY_GAP}% 미만입니다 (${top.score}% / ${second.score}%).`,
      isGeneric: false,
    };
  }
  return { status: 'AUTO_MATCHED', matchType: top.score === 100 ? 'EXACT' : 'FUZZY', clientId: top.clientId, score: top.score, reason: null, isGeneric: false };
}
