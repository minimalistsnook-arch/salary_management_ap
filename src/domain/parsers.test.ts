import { describe, expect, test } from 'vitest';
import { parseBankRows } from './bankExcelParser';
import { interpretClientSheet, parseCsv } from './clientSheet';
import { transactionFingerprint } from './fingerprint';
import { inferPaymentDate, parseLegacyAdvisorySheet } from './legacyAdvisoryParser';

describe('통장 Excel 파서', () => {
  const header = ['번호', '거래일시', '보낸분/받는분', '출금액', '입금액'];

  test('상단 안내 행을 건너뛰고 헤더를 찾는다', () => {
    const r = parseBankRows(
      [
        ['신한은행 거래내역조회'],
        ['조회기간: 2026-09-01 ~ 2026-09-30'],
        header,
        [1, '2026-09-24 10:11:12', '남산운수 주식회사', 0, 440000],
        [2, 46289.5, 'CMS집금', '0', '219,725'],
        [null, null, '합계', 0, 659725],
      ],
      1,
    );
    expect(r.errors).toEqual([]);
    expect(r.headerRowNumber).toBe(3);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toEqual({ excelRowNumber: 4, bankRowNo: '1', transactionDatetime: '2026-09-24 10:11:12', senderRaw: '남산운수 주식회사', withdrawalAmount: 0, depositAmount: 440000 });
    expect(r.rows[1].transactionDatetime).toBe('2026-09-24 12:00:00'); // Excel serial
    expect(r.rows[1].depositAmount).toBe(219725);
    expect(r.warnings.some((w) => w.includes('6행'))).toBe(true);
  });

  test('원본 보낸분 문자열(공백 포함)을 그대로 보존', () => {
    const r = parseBankRows([header, [1, '2026-09-24', ' 광일운수(주) 05월 ', 0, 275000]]);
    expect(r.rows[0].senderRaw).toBe(' 광일운수(주) 05월 ');
  });

  test('필수 컬럼 누락 시 구체적 오류', () => {
    const r = parseBankRows([['번호', '일자', '받는사람', '출금액', '입금액'], [1, '2026-09-24', 'x', 0, 1]]);
    expect(r.errors).toContain("필수 컬럼 '거래일시'을 찾을 수 없습니다.");
    expect(r.errors).toContain("필수 컬럼 '보낸분'을 찾을 수 없습니다.");
    expect(r.rows).toEqual([]);
  });

  test('숫자가 아닌 입금액 → 행 번호 포함 오류', () => {
    const rows: unknown[][] = [header];
    for (let i = 2; i <= 30; i++) rows.push([i - 1, '2026-09-01', '가', 0, 1000]);
    rows.push([30, '2026-09-02', '나', 0, '십만원']);
    const r = parseBankRows(rows);
    expect(r.errors).toContain("입금액에 숫자가 아닌 값이 있습니다: '십만원'. Excel 31행.");
  });

  test('fingerprint 는 결정적이며 행번호가 다르면 달라진다', async () => {
    const base = { transactionDatetime: '2026-09-24 10:00:00', senderRaw: '남산운수', withdrawalAmount: 0, depositAmount: 440000, excelRowNumber: 5 };
    expect(await transactionFingerprint(base)).toBe(await transactionFingerprint({ ...base }));
    expect(await transactionFingerprint(base)).not.toBe(await transactionFingerprint({ ...base, excelRowNumber: 6 }));
  });
});

describe('거래처 마스터 시트 해석', () => {
  test('B열=거래처명, C열=계약금액, A열 값이 있으면 별칭 행', () => {
    const csv = ' ,회 원 사,계약금액,,\n,,,,\n,남산운수마을버스㈜,"220,000",,\n,"충남식당,삼정집","110,000",,\n,러스크강동병원,"1,100,000",,\n,남산운수마을버스㈜,"999",,\n송연탁 ,러스크강동병원,"88,000",,\n경원여객,x,,,\n';
    const r = interpretClientSheet(parseCsv(csv));
    expect(r.clients).toEqual([
      { name: '남산운수마을버스㈜', contractAmount: 220000, sourceRow: 3 },
      { name: '충남식당,삼정집', contractAmount: 110000, sourceRow: 4 },
      { name: '러스크강동병원', contractAmount: 1100000, sourceRow: 5 },
    ]);
    expect(r.aliases).toEqual([{ rawSender: '송연탁', clientName: '러스크강동병원', sourceRow: 7 }]);
    expect(r.warnings.some((w) => w.includes('중복'))).toBe(true);
  });
});

describe('기존 노무자문비 시트 가져오기', () => {
  test('연도(병합) → 월 헤더, 셀의 M/D 입금일을 연월로 해석', () => {
    const rows = [
      ['', '', '2025', '', '', '2026'],
      ['거래처', '계약금액', '11월', '12월', '1월', '2월'],
      ['남산운수마을버스㈜', 220000, '12/20', '1/5', '9/10, 9/24', '미납'],
      ['합계', '', '', '', '', ''],
    ];
    const r = parseLegacyAdvisorySheet(rows);
    expect(r.errors).toEqual([]);
    expect(r.clients).toHaveLength(1);
    expect(r.clients[0].contractAmount).toBe(220000);
    expect(r.clients[0].payments.map((p) => [p.serviceMonth, p.paymentDates])).toEqual([
      ['2025-11', ['2025-12-20']],
      ['2025-12', ['2026-01-05']],
      ['2026-01', ['2026-09-10', '2026-09-24']],
    ]);
  });

  test('입금일 연도 추정: 선납은 3개월 전까지, 연체는 9개월 후까지', () => {
    expect(inferPaymentDate('2026-01', 12, 28)).toBe('2025-12-28');
    expect(inferPaymentDate('2026-05', 9, 24)).toBe('2026-09-24');
    expect(inferPaymentDate('2025-12', 1, 5)).toBe('2026-01-05');
  });
});
