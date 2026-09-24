import type { WorkBook } from 'xlsx';
import { sha256Hex } from '../domain/fingerprint';

export interface SheetRows {
  name: string;
  rows: unknown[][];
  firstRowNumber: number;
}

export interface ReadWorkbook {
  filename: string;
  fileHash: string;
  sheets: SheetRows[];
}

/** 브라우저에서 Excel 파일을 2차원 배열로 읽는다 (원본 셀 값 유지, 날짜는 serial 숫자) */
export async function readExcelFile(file: File): Promise<ReadWorkbook> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const fileHash = await sha256Hex(buf);
  let wb: WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'array', cellDates: false, cellFormula: false, cellHTML: false });
  } catch {
    throw new Error('Excel 파일을 열 수 없습니다. 암호가 걸려 있거나 손상된 파일인지 확인해주세요.');
  }
  const sheets = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) return { name, rows: [], firstRowNumber: 1 };
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
      range: { s: { r: range.s.r, c: 0 }, e: range.e },
    });
    return { name, rows, firstRowNumber: range.s.r + 1 };
  });
  return { filename: file.name, fileHash, sheets };
}
