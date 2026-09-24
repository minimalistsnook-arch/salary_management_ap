import { parseCsv } from '../../../src/domain/clientSheet';

/**
 * 거래처 마스터 원본 adapter. 시트의 행 배열(A, B, C ...)을 반환한다.
 * 공개 CSV 방식이 막히면 Google Sheets API 방식으로 교체할 수 있다.
 */
export interface ClientSourceAdapter {
  readonly name: string;
  fetchRows(): Promise<string[][]>;
}

export interface ClientSourceEnv {
  GOOGLE_SHEET_ID?: string;
  GOOGLE_SHEET_GID?: string;
  GOOGLE_SHEET_RANGE?: string;
  GOOGLE_API_KEY?: string;
  CLIENT_SOURCE_MODE?: string;
}

const TIMEOUT_MS = 15000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/** 공개 링크 CSV export */
export class GoogleSheetCsvAdapter implements ClientSourceAdapter {
  readonly name = 'google-sheet-csv';
  constructor(
    private sheetId: string,
    private gid = '0',
  ) {}

  async fetchRows(): Promise<string[][]> {
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(this.sheetId)}/export?format=csv&gid=${encodeURIComponent(this.gid)}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Google Sheet 응답 오류 (HTTP ${res.status})`);
    const text = await res.text();
    if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('Google Sheet가 CSV 대신 HTML을 반환했습니다. 공유 설정(링크가 있는 모든 사용자)을 확인해주세요.');
    return parseCsv(text);
  }
}

/** Google Sheets API v4 (API Key) */
export class GoogleSheetsApiAdapter implements ClientSourceAdapter {
  readonly name = 'google-sheets-api';
  constructor(
    private sheetId: string,
    private apiKey: string,
    private range = 'A:C',
  ) {}

  async fetchRows(): Promise<string[][]> {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.sheetId)}/values/${encodeURIComponent(this.range)}?key=${encodeURIComponent(this.apiKey)}&valueRenderOption=FORMATTED_VALUE`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Google Sheets API 오류 (HTTP ${res.status})`);
    const body = (await res.json()) as { values?: unknown[][] };
    return (body.values ?? []).map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))));
  }
}

export function createClientSourceAdapter(env: ClientSourceEnv): ClientSourceAdapter {
  const sheetId = env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error('GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.');
  if (env.CLIENT_SOURCE_MODE === 'api') {
    if (!env.GOOGLE_API_KEY) throw new Error('CLIENT_SOURCE_MODE=api 에는 GOOGLE_API_KEY 가 필요합니다.');
    return new GoogleSheetsApiAdapter(sheetId, env.GOOGLE_API_KEY, env.GOOGLE_SHEET_RANGE || 'A:C');
  }
  return new GoogleSheetCsvAdapter(sheetId, env.GOOGLE_SHEET_GID || '0');
}
