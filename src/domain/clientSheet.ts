import { parseWon } from './money';

/**
 * 거래처 마스터 Google Sheet 해석.
 * - B열 = 정확한 거래처명, C열 = 월 계약금액
 * - A열에 값이 있는 행은 '통장표기(A) → 거래처(B)' 별칭 매핑 행으로 보고 거래처로 등록하지 않는다.
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
  const warnings: string[] = [];
  const seen = new Map<string, number>();

  rows.forEach((r, i) => {
    const sourceRow = i + 1;
    const a = (r[0] ?? '').trim();
    const b = (r[1] ?? '').trim();
    const cRaw = (r[2] ?? '').trim();
    if (!b) return;
    if (a) {
      if (b.toLowerCase() !== 'x') aliasRows.push({ rawSender: a, clientName: b, sourceRow });
      return;
    }
    const amount = parseWon(cRaw);
    if (amount === null || amount < 0) {
      if (cRaw && !/금액/.test(cRaw)) warnings.push(`${sourceRow}행 '${b}': 계약금액 '${cRaw}'을 읽을 수 없어 제외했습니다.`);
      return;
    }
    if (seen.has(b)) {
      warnings.push(`${sourceRow}행 '${b}': ${seen.get(b)}행과 중복된 거래처명이라 제외했습니다.`);
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
  return { clients, aliases, warnings };
}
