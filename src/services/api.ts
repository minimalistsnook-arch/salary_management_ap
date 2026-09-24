import type {
  AdvisoryResponse,
  ClientsResponse,
  DashboardResponse,
  ExportResponse,
  ImportBatch,
  ImportCommitResponse,
  ImportPreviewRequest,
  ImportPreviewResponse,
  IndividualCaseRow,
  LegacyCommitResponse,
  LegacyPreviewRequest,
  LegacyPreviewResponse,
  SyncResult,
  SyncStatus,
  TransactionDetail,
  TransactionRow,
} from '../domain/dto';
import type { Client, YearMonth } from '../domain/types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('서버에 연결할 수 없습니다. API 서버(wrangler)가 실행 중인지 확인해주세요.', 0, null);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(`서버 응답을 읽을 수 없습니다 (HTTP ${res.status}).`, res.status, text.slice(0, 300));
  }
  if (!res.ok) {
    const d = data as { error?: string; details?: unknown } | null;
    throw new ApiError(d?.error ?? `요청 실패 (HTTP ${res.status})`, res.status, d?.details ?? null);
  }
  return data as T;
}

export const api = {
  dashboard: () => request<DashboardResponse>('GET', '/api/dashboard'),
  clients: () => request<ClientsResponse>('GET', '/api/clients'),
  syncClients: () => request<SyncResult>('POST', '/api/clients/sync'),
  syncStatus: () => request<SyncStatus>('GET', '/api/clients/sync-status'),
  setStartMonth: (id: number, month: YearMonth | null) => request<Client>('PATCH', `/api/clients/${id}`, { management_start_month: month ?? '' }),
  deleteAlias: (id: number) => request<{ ok: true }>('DELETE', `/api/aliases/${id}`),

  previewImport: (req: ImportPreviewRequest) => request<ImportPreviewResponse>('POST', '/api/imports/preview', req),
  commitImport: (req: ImportPreviewRequest) => request<ImportCommitResponse>('POST', '/api/imports/commit', req),
  batches: () => request<ImportBatch[]>('GET', '/api/imports'),

  transactions: (year?: number) => request<TransactionRow[]>('GET', `/api/transactions${year ? `?year=${year}` : ''}`),
  transaction: (id: number) => request<TransactionDetail>('GET', `/api/transactions/${id}`),
  assign: (id: number, body: { clientId: number; startMonth?: YearMonth | null; note?: string | null }) => request('POST', `/api/transactions/${id}/assign`, body),
  setAllocations: (id: number, body: { lines: { serviceMonth: YearMonth; amount: number }[]; note?: string | null }) =>
    request('POST', `/api/transactions/${id}/allocations`, body),
  unassign: (id: number) => request('POST', `/api/transactions/${id}/unassign`),
  setNote: (id: number, note: string) => request('POST', `/api/transactions/${id}/note`, { note }),

  individual: (year?: number) => request<IndividualCaseRow[]>('GET', `/api/individual${year ? `?year=${year}` : ''}`),
  advisory: (year: number) => request<AdvisoryResponse>('GET', `/api/advisory?year=${year}`),
  legacyPreview: (req: LegacyPreviewRequest) => request<LegacyPreviewResponse>('POST', '/api/legacy/preview', req),
  legacyCommit: (req: LegacyPreviewRequest) => request<LegacyCommitResponse>('POST', '/api/legacy/commit', req),

  exportData: (year: number) => request<ExportResponse>('GET', `/api/export?year=${year}`),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const details = Array.isArray(e.details) ? `\n${e.details.join('\n')}` : '';
    return e.message + details;
  }
  return (e as Error)?.message ?? String(e);
}
