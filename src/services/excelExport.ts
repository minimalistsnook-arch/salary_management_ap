import type * as XLSXTypes from 'xlsx';
import { buildClientYearRow, type GridAllocation } from '../domain/advisoryGrid';
import type { ExportResponse } from '../domain/dto';
import { MATCH_STATUS_LABEL, PAYMENT_STATUS_LABEL } from '../domain/labels';
import { shortDate } from '../domain/month';

type Row = (string | number | null)[];

function sheet(XLSX: typeof XLSXTypes, header: string[], rows: Row[], widths: number[]): XLSXTypes.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = widths.map((wch) => ({ wch }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  return ws;
}

const localTime = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function buildWorkbook(XLSX: typeof XLSXTypes, data: ExportResponse): XLSXTypes.WorkBook {
  const wb = XLSX.utils.book_new();

  // 1. 거래처입출금내역 (배정 1건당 1행, 금액은 거래의 첫 행에만 표시)
  const txRows: Row[] = [];
  for (const t of [...data.transactions].reverse()) {
    const base = [t.transaction_datetime, t.sender_raw, t.client_name, t.client_name ? t.similarity_score / 100 : null];
    const allocs = t.allocations.length ? t.allocations : [null];
    allocs.forEach((a, i) => {
      txRows.push([
        ...base,
        i === 0 ? t.deposit_amount : null,
        i === 0 ? t.withdrawal_amount : null,
        a ? a.contract_amount_snapshot : t.contract_amount,
        a ? a.service_month : null,
        a ? a.allocated_amount : null,
        a ? PAYMENT_STATUS_LABEL[a.month_status] : null,
        t.note,
        MATCH_STATUS_LABEL[t.match_status],
        t.filename,
      ]);
    });
  }
  const ws1 = sheet(
    XLSX,
    ['거래일시', '통장 원본명', '거래처 정식명', '매칭률', '입금액', '출금액', '계약금액', '적용연월', '배정금액', '납부상태', '비고', '매칭상태', '업로드 파일'],
    txRows,
    [19, 24, 24, 8, 12, 12, 12, 10, 12, 9, 24, 10, 28],
  );
  txRows.forEach((_, i) => {
    const c = ws1[XLSX.utils.encode_cell({ r: i + 1, c: 3 })];
    if (c) c.z = '0%';
    for (const col of [4, 5, 6, 8]) {
      const cell = ws1[XLSX.utils.encode_cell({ r: i + 1, c: col })];
      if (cell) cell.z = '#,##0';
    }
  });
  XLSX.utils.book_append_sheet(wb, ws1, '거래처입출금내역');

  // 2. 노무자문비 (선택 연도)
  const { advisory } = data;
  const byClient = new Map<number, GridAllocation[]>();
  for (const a of advisory.allocations) byClient.set(a.client_id, [...(byClient.get(a.client_id) ?? []), a]);
  const gridRows: Row[] = advisory.clients.map((c) => {
    const r = buildClientYearRow(c, byClient.get(c.id) ?? [], advisory.year, advisory.currentMonth);
    return [
      c.name,
      c.current_contract_amount,
      ...r.cells.map((cell) => {
        const dates = [...new Set(cell.payments.map((p) => shortDate(p.payment_date)))].join(', ');
        if (cell.state === 'PAID') return dates;
        if (cell.state === 'PARTIAL') return `${dates} (부분 ${cell.paid.toLocaleString('ko-KR')}/${cell.due.toLocaleString('ko-KR')})`;
        if (cell.state === 'UNPAID') return '미납';
        return null;
      }),
      r.annualPaid,
      r.receivable,
    ];
  });
  XLSX.utils.book_append_sheet(
    wb,
    sheet(XLSX, ['거래처명', '계약금액', ...Array.from({ length: 12 }, (_, i) => `${i + 1}월`), '총입금', '미수금'], gridRows, [26, 11, ...Array(12).fill(11), 12, 12]),
    '노무자문비',
  );

  // 3. 미매칭검토
  const review = data.transactions.filter((t) => t.deposit_amount > 0 && (t.match_status === 'REVIEW_REQUIRED' || t.match_status === 'UNMATCHED'));
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
    XLSX,
      ['거래일시', '통장 원본명', '입금액', '추천 거래처', '매칭률', '상태', '비고', '업로드 파일'],
      review.map((t) => [t.transaction_datetime, t.sender_raw, t.deposit_amount, t.client_name, t.client_name ? t.similarity_score / 100 : null, MATCH_STATUS_LABEL[t.match_status], t.note, t.filename]),
      [19, 24, 12, 24, 8, 10, 24, 28],
    ),
    '미매칭검토',
  );

  // 3-1. 개별건 (매칭되지 않은 입금 전체, 유사도 40% 이상 표시)
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      XLSX,
      ['거래일시', '통장 원본명', '입금액', '유사 거래처', '유사도', '유사 40% 이상', '상태', '비고', '업로드 파일'],
      data.individual.map((t) => [
        t.transaction_datetime,
        t.sender_raw,
        t.deposit_amount,
        t.isGeneric ? '(공통 입금명)' : (t.bestCandidate?.clientName ?? null),
        t.bestCandidate && !t.isGeneric ? t.bestCandidate.score / 100 : null,
        t.similar ? '유사' : null,
        MATCH_STATUS_LABEL[t.match_status],
        t.note,
        t.filename,
      ]),
      [19, 24, 12, 24, 8, 11, 10, 24, 28],
    ),
    '개별건',
  );

  // 4. 거래처마스터
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
    XLSX,
      ['거래처명', '월 계약금액', '관리 시작월', '상태', '시트 행', '수정일시'],
      data.clients.map((c) => [c.name, c.current_contract_amount, c.management_start_month, c.active ? '활성' : '비활성', c.source_row, localTime(c.updated_at)]),
      [28, 12, 11, 8, 8, 17],
    ),
    '거래처마스터',
  );

  // 5. 가져오기이력
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
    XLSX,
      ['가져온 시각', '파일명', '전체 행', '신규 등록', '중복(미등록)', '확정 입금', '파일 hash'],
      data.batches.map((b) => [localTime(b.imported_at), b.filename, b.total_rows, b.inserted_rows, b.duplicate_rows, b.confirmed_rows, b.file_hash]),
      [17, 32, 9, 9, 11, 9, 66],
    ),
    '가져오기이력',
  );
  return wb;
}

export async function downloadWorkbook(data: ExportResponse): Promise<string> {
  const XLSX = await import('xlsx');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const filename = `노무자문관리_전체추출_${data.year}_${stamp}.xlsx`;
  XLSX.writeFile(buildWorkbook(XLSX, data), filename, { compression: true });
  return filename;
}
