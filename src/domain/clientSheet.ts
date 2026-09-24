import { parseWon } from './money';

/**
 * 거래처 마스터 Google Sheet 해석.
 * - B열 = 정확한 거래처명, C열 = 월 계약금액 → B·C 가 있으면 항상 거래처
 * - A열 값 = 그 거래처(B)의 통장 표기 별칭 (예: A '(주)마을버스남산운수' → B '남산운수마을버스㈜')
 * - B열이 'x' 이면 A열 입금처는 거래처가 아님 (제외)
 * - 같은 거래처명이 다시 나오면 먼저 나온 행의 계약금액을 사용하고 경고
 */

export interface SheetClient {
  name: string;
  contractAmount: number;
  sourceRow: number;
}
export interface SheetAlias {
  rawSender: string;
  clientName: string;
  sourceRow: number;
}
export interface ClientSheetResult {
  clients: SheetClient[];
  aliases: SheetAlias[];
  /** A열 값 + B열 'x' : 거래처가 아닌 입금처 */
  exclusions: { rawSender: string; sourceRow: number }[];
  warnings: string[];
}

/** RFC4180 CSV 파서 (따옴표/콤마/줄바꿈 처리) */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function interpretClientSheet(rows: string[][]): ClientSheetResult {
  const clients: SheetClient[] = [];
  const aliasRows: SheetAlias[] = [];
  const exclusions: { rawSender: string; sourceRow: number }[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, number>();

  rows.forEach((r, i) => {
    const sourceRow = i + 1;
    const a = (r[0] ?? '').trim();
    const b = (r[1] ?? '').trim();
    const cRaw = (r[2] ?? '').trim();
    if (!b) return;
    if (b.toLowerCase() === 'x') {
      if (a) exclusions.push({ rawSender: a, sourceRow });
      return;
    }
    if (a) aliasRows.push({ rawSender: a, clientName: b, sourceRow });
    const amount = parseWon(cRaw);
    if (amount === null || amount < 0) {
      if (cRaw && !/금액/.test(cRaw)) warnings.push(`${sourceRow}행 '${b}': 계약금액 '${cRaw}'을 읽을 수 없어 제외했습니다.`);
      return;
    }
    if (seen.has(b)) {
      if (!a) warnings.push(`${sourceRow}행 '${b}': ${seen.get(b)}행과 중복된 거래처명이라 제외했습니다.`);
      return;
    }
    seen.set(b, sourceRow);
    clients.push({ name: b, contractAmount: amount, sourceRow });
  });

  const aliases = aliasRows.filter((al) => {
    if (seen.has(al.clientName)) return true;
    warnings.push(`${al.sourceRow}행 별칭 '${al.rawSender}' → '${al.clientName}': 해당 거래처가 목록에 없어 제외했습니다.`);
    return false;
  });
  return { clients, aliases, exclusions, warnings };
}
