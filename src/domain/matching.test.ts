import { describe, expect, test } from 'vitest';
import { AUTO_MATCH_THRESHOLD, buildMatchIndex, classifyCandidates, matchSender, similarity } from './matching';
import { canLearnAlias, isGenericSender, normalizeName } from './normalize';

const clients = [
  { id: 1, name: '남산운수마을버스㈜' },
  { id: 2, name: '광일운수㈜' },
  { id: 3, name: '㈜윈즈아이티' },
  { id: 4, name: '청진운수㈜' },
  { id: 5, name: '청진교통(서초)' },
  { id: 6, name: '청진교통(화성)' },
  { id: 7, name: '(주)명승교통' },
  { id: 8, name: '주식회사 명승운수' },
];
const index = buildMatchIndex(clients, []);

describe('정규화', () => {
  test('법인 표시·공백·전각 차이를 동일하게 처리', () => {
    for (const v of ['광일운수(주)', '광일운수㈜', '주식회사 광일운수', ' 광일운수 주식회사 ', 'ＫＷＡＮＧ 광일운수'.slice(6)]) {
      expect(normalizeName(v)).toBe('광일운수');
    }
    expect(normalizeName('㈜윈즈아이티')).toBe(normalizeName('주식회사 윈즈아이티'));
    expect(normalizeName('(주)윈즈아이티')).toBe('윈즈아이티');
    expect(normalizeName('ＡＢＣ　Ｃｏ')).toBe('abcco');
  });

  test('원본 문자열은 변경하지 않는다', () => {
    const raw = '광일운수(주)';
    normalizeName(raw);
    expect(raw).toBe('광일운수(주)');
  });

  test('법인 표기 변형은 높은 일치율', () => {
    expect(similarity('광일운수(주)', '광일운수㈜')).toBe(100);
    expect(similarity('주식회사 광일운수', '광일운수㈜')).toBe(100);
    expect(similarity('(주)윈즈아이티', '㈜윈즈아이티')).toBe(100);
    expect(similarity('주식회사 윈즈아이티', '㈜윈즈아이티')).toBe(100);
  });
});

describe('거래처 매칭', () => {
  test('통장 표기 "남산운수 주식회사" → 남산운수마을버스㈜ 자동매칭 후보', () => {
    const r = matchSender('남산운수 주식회사', index);
    expect(r.clientId).toBe(1);
    expect(r.score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
    expect(r.status).toBe('AUTO_MATCHED');
  });

  test('CASE 5: 유사도 69% → 자동매칭 금지, REVIEW_REQUIRED', () => {
    const r = classifyCandidates([{ clientId: 1, clientName: 'A', score: 69 }]);
    expect(r.status).toBe('REVIEW_REQUIRED');
    expect(r.status).not.toBe('AUTO_MATCHED');
  });

  test('CASE 6: 후보 82% / 80% → 자동확정 금지, REVIEW_REQUIRED', () => {
    const r = classifyCandidates([
      { clientId: 1, clientName: 'A', score: 82 },
      { clientId: 2, clientName: 'B', score: 80 },
    ]);
    expect(r.status).toBe('REVIEW_REQUIRED');
  });

  test('1·2위 차이 5% 이상이면 자동매칭', () => {
    expect(classifyCandidates([{ clientId: 1, clientName: 'A', score: 83 }, { clientId: 2, clientName: 'B', score: 78 }]).status).toBe('AUTO_MATCHED');
  });

  test('유사도 50% 미만은 미매칭', () => {
    expect(classifyCandidates([{ clientId: 1, clientName: 'A', score: 40 }]).status).toBe('UNMATCHED');
    expect(matchSender('홍길동', index).status).toBe('UNMATCHED');
  });

  test('"청진" 처럼 여러 거래처에 걸치는 표기는 확인필요', () => {
    expect(matchSender('청진', index).status).toBe('REVIEW_REQUIRED');
  });

  test('CASE 9: CMS집금 → 자동 거래처 지정 금지, REVIEW_REQUIRED', () => {
    for (const s of ['CMS집금', 'cms 집금', '카드결제', '카드밴넷', '신한', '입금', '자동이체']) {
      const r = matchSender(s, index);
      expect(r.status).toBe('REVIEW_REQUIRED');
      expect(r.clientId).toBeNull();
      expect(r.isGeneric).toBe(true);
      expect(isGenericSender(s)).toBe(true);
      expect(canLearnAlias(s)).toBe(false);
    }
  });

  test('별칭이 있으면 해당 거래처로 매칭', () => {
    const idx = buildMatchIndex(clients, [{ normalized_sender: normalizeName('송연탁'), client_id: 7 }]);
    const r = matchSender('송연탁', idx);
    expect(r).toMatchObject({ status: 'AUTO_MATCHED', matchType: 'ALIAS', clientId: 7 });
  });

  test('시트 A열 표기와 비슷하면 B열 거래처로 매칭 (정확히 같지 않아도)', () => {
    const idx = buildMatchIndex(
      [...clients, { id: 20, name: '㈜포레스트힐 -싸이칸' }, { id: 21, name: '반석정형외과' }],
      [
        { normalized_sender: normalizeName('싸이칸'), client_id: 20, raw_sender: '싸이칸', source: 'SHEET' },
        { normalized_sender: normalizeName('반석정형외과(장일석)'), client_id: 21, raw_sender: '반석정형외과(장일석)', source: 'SHEET' },
      ],
    );
    const a = matchSender('싸이칸본점', idx);
    expect(a).toMatchObject({ status: 'AUTO_MATCHED', clientId: 20 });
    expect(a.candidates[0].viaAlias).toBe('싸이칸');
    expect(a.reason).toContain("A열 '싸이칸'");

    const b = matchSender('장일석', idx); // A열 '반석정형외과(장일석)' 에 포함 → 추천만
    expect(b.clientId).toBe(21);
    expect(b.status).toBe('REVIEW_REQUIRED');
  });

  test('수동 확정으로 학습된 별칭은 정확 일치만 사용 (유사도 비교 안 함)', () => {
    const idx = buildMatchIndex(clients, [{ normalized_sender: normalizeName('김대표'), client_id: 2, raw_sender: '김대표', source: 'MANUAL' }]);
    expect(matchSender('김대표', idx).clientId).toBe(2);
    expect(matchSender('김대호', idx).clientId).not.toBe(2);
  });
});
