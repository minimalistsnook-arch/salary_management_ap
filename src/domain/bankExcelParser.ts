import { cellText, parseAmountCell, parseDateTimeCell } from './excelValues';

/**
 * 통장 거래내역 Excel 파서 (라이브러리 독립).
 * 입력: 시트의 2차원 배열 (행 순서대로, 첫 행의 Excel 행번호 firstRowNumber)
 * 기본 구조: A=번호, B=거래일시, C=보낸분/받는분, D=출금액, E=입금액
 * 은행마다 상단 안내 행이 있으므로 헤더 행을 찾아 열 위치를 결정한다.
 */

export interface ParsedBankRow {
  excelRowNumber: number;
  bankRowNo: string | null;
  transactionDatetime: string; // 'YYYY-MM-DD HH:mm:ss'
  senderRaw: string; // 원본 그대로
  withdrawalAmount: number;
  depositAmount: number;
}

export interface BankParseResult {
  rows: ParsedBankRow[];
  errors: string[];
  warnings: string[];
  headerRowNumber: number | null;
  columns: Partial<Record<ColumnRole, string>>;
}

export type ColumnRole = 'no' | 'datetime' | 'sender' | 'withdrawal' | 'deposit';

const ROLE_LABEL: Record<ColumnRole, string> = {
  no: '번호',
  datetime: '거래일시',
  sender: '보낸분',
  withdrawal: '출금액',
  deposit: '입금액',
};

const ROLE_SYNONYMS: Record<ColumnRole, string[]> = {
  no: ['번호', 'no', 'no.', '순번', '순서'],
  datetime: ['거래일시', '거래일자', '거래일', '거래시간', '일시', '거래일자시간', '거래일시분'],
  sender: ['보낸분/받는분', '보낸분받는분', '보낸분', '받는분', '보낸분/받는분명', '입금자', '의뢰인/수취인', '기재내용', '거래내용', '적요', '내용'],
  withdrawal: ['출금액', '출금', '출금금액', '찾으신금액', '지급액', '지급금액', '출금(원)'],
  deposit: ['입금액', '입금', '입금금액', '맡기신금액', '입금(원)'],
};

const REQUIRED: ColumnRole[] = ['datetime', 'sender', 'withdrawal', 'deposit'];

const norm = (v: unknown) => cellText(v).normalize('NFKC').replace(/\s+/g, '').toLowerCase();

function colLetter(idx: number): string {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function detectRoles(row: unknown[]): Partial<Record<ColumnRole, number>> {
  const found: Partial<Record<ColumnRole, number>> = {};
  // 우선순위: 동의어 목록 앞쪽이 강함 (예: '보낸분' 이 '적요' 보다 우선)
  for (const role of Object.keys(ROLE_SYNONYMS) as ColumnRole[]) {
    let best: { idx: number; rank: number } | null = null;
    row.forEach((cell, idx) => {
      const t = norm(cell);
      if (!t) return;
      let rank = ROLE_SYNONYMS[role].indexOf(t);
      if (rank < 0 && role === 'sender' && (t.includes('보낸분') || t.includes('받는분'))) rank = 0;
      if (rank >= 0 && (!best || rank < best.rank)) best = { idx, rank };
    });
    if (best) found[role] = (best as { idx: number }).idx;
  }
  return found;
}

export function parseBankRows(rows: unknown[][], firstRowNumber = 1): BankParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const out: ParsedBankRow[] = [];

  // 1) 헤더 행 찾기 (상위 30행)
  let headerIdx = -1;
  let roles: Partial<Record<ColumnRole, number>> = {};
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = detectRoles(rows[i] ?? []);
    if (Object.keys(r).length > Object.keys(roles).length) {
      roles = r;
      headerIdx = i;
    }
  }
  if (Object.keys(roles).length < 2) {
    roles = {};
    headerIdx = -1;
  }
  const missing = REQUIRED.filter((r) => roles[r] === undefined);
  for (const m of missing) errors.push(`필수 컬럼 '${ROLE_LABEL[m]}'을 찾을 수 없습니다.`);
  if (missing.length) {
    errors.push(
      headerIdx < 0
        ? '헤더 행(번호 | 거래일시 | 보낸분 | 출금액 | 입금액)을 찾지 못했습니다. 은행에서 받은 원본 거래내역 파일인지 확인해주세요.'
        : `헤더는 Excel ${firstRowNumber + headerIdx}행에서 찾았지만 일부 컬럼명이 다릅니다.`,
    );
    return { rows: [], errors, warnings, headerRowNumber: headerIdx >= 0 ? firstRowNumber + headerIdx : null, columns: {} };
  }
  if (roles.no === undefined) warnings.push("'번호' 컬럼이 없어 번호 없이 가져옵니다.");

  const columns: Partial<Record<ColumnRole, string>> = {};
  for (const [k, v] of Object.entries(roles)) columns[k as ColumnRole] = colLetter(v as number);

  // 2) 데이터 행
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const excelRow = firstRowNumber + i;
    if (row.every((c) => cellText(c).trim() === '')) continue;

    const get = (role: ColumnRole) => (roles[role] === undefined ? undefined : row[roles[role] as number]);
    const rawDt = get('datetime');
    const senderCell = get('sender');
    const senderRaw = senderCell === null || senderCell === undefined ? '' : cellText(senderCell);
    const wd = parseAmountCell(get('withdrawal'));
    const dp = parseAmountCell(get('deposit'));

    if (cellText(rawDt).trim() === '') {
      const hasAmount = (wd.ok && wd.value > 0) || (dp.ok && dp.value > 0);
      if (hasAmount && senderRaw.trim() && !/합계|총계|소계|^계$/.test(senderRaw.trim())) {
        errors.push(`거래일시가 비어 있습니다. Excel ${excelRow}행.`);
      } else {
        warnings.push(`Excel ${excelRow}행: 거래일시가 없어 합계/안내 행으로 보고 제외했습니다.`);
      }
      continue;
    }
    const dt = parseDateTimeCell(rawDt);
    if (!dt) {
      errors.push(`거래일시 형식을 알 수 없습니다: '${cellText(rawDt)}'. Excel ${excelRow}행.`);
      continue;
    }
    if (!wd.ok) errors.push(`출금액에 ${wd.reason}이 있습니다: '${cellText(get('withdrawal'))}'. Excel ${excelRow}행.`);
    if (!dp.ok) errors.push(`입금액에 ${dp.reason}이 있습니다: '${cellText(get('deposit'))}'. Excel ${excelRow}행.`);
    if (!wd.ok || !dp.ok) continue;

    if (wd.value === 0 && dp.value === 0) {
      warnings.push(`Excel ${excelRow}행: 입금액과 출금액이 모두 0이라 제외했습니다.`);
      continue;
    }
    if (wd.value > 0 && dp.value > 0) {
      warnings.push(`Excel ${excelRow}행: 입금액과 출금액이 모두 있습니다. 원본 그대로 저장합니다.`);
    }
    if (!senderRaw.trim()) warnings.push(`Excel ${excelRow}행: 보낸분/받는분이 비어 있습니다.`);

    const noCell = get('no');
    out.push({
      excelRowNumber: excelRow,
      bankRowNo: noCell === null || noCell === undefined || cellText(noCell) === '' ? null : cellText(noCell),
      transactionDatetime: dt,
      senderRaw,
      withdrawalAmount: wd.value,
      depositAmount: dp.value,
    });
  }

  if (!errors.length && out.length === 0) errors.push('가져올 거래 행이 없습니다. 헤더 아래에 거래 데이터가 있는지 확인해주세요.');
  return { rows: errors.length ? [] : out, errors, warnings, headerRowNumber: firstRowNumber + headerIdx, columns };
}
