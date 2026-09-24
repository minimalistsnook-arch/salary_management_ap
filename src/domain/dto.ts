/** 브라우저 ↔ API 공용 요청/응답 타입 */
import type { AllocationLine } from './allocation';
import type { ParsedBankRow } from './bankExcelParser';
import type { MatchCandidate, MatchResult } from './matching';
import type { AllocationSource, Client, ClientAlias, MatchStatus, MatchType, PaymentStatus, YearMonth } from './types';
import type { GridAllocation } from './advisoryGrid';
import type { LegacyClientRow } from './legacyAdvisoryParser';

// ---------- 통장 업로드 ----------
export interface RowDecision {
  /** 사용자가 직접 선택/확정한 거래처 (없으면 자동매칭 결과 사용) */
  clientId?: number | null;
  /** 첫 적용월 지정 (관리 시작월 없는 거래처 또는 재지정) */
  startMonth?: YearMonth | null;
  /** 이번 저장에서 확정할지 */
  selected?: boolean;
  note?: string | null;
}

export interface ImportPreviewRequest {
  filename: string;
  fileHash: string;
  rows: ParsedBankRow[];
  decisions?: Record<number, RowDecision>; // key = excelRowNumber
}

export type RowKind = 'DEPOSIT' | 'WITHDRAWAL' | 'BOTH';

export interface PreviewRow extends ParsedBankRow {
  transactionHash: string;
  kind: RowKind;
  duplicate: boolean; // 이미 등록된 거래
  duplicateSuspect: string | null; // 같은 내용의 거래가 다른 행/파일에 존재
  autoMatch: MatchResult;
  clientId: number | null;
  clientName: string | null;
  contractAmount: number | null;
  similarity: number;
  matchStatus: MatchStatus;
  matchType: MatchType;
  startMonth: YearMonth | null;
  needsStartMonth: boolean;
  allocation: AllocationLine[];
  unallocated: number;
  allocationError: string | null;
  feeWarning: string | null;
  selected: boolean;
  selectable: boolean;
  blockReason: string | null;
  note: string | null;
}

export interface ImportPreviewResponse {
  alreadyImportedFile: { id: number; imported_at: string } | null;
  rows: PreviewRow[];
  summary: {
    total: number;
    duplicates: number;
    deposits: number;
    withdrawals: number;
    autoMatched: number;
    review: number;
    unmatched: number;
    selected: number;
  };
}

export interface ImportCommitResponse {
  batchId: number | null;
  inserted: number;
  duplicates: number;
  confirmed: number;
  pendingReview: number;
  allocations: number;
  aliasesLearned: number;
}

// ---------- 조회 ----------
export interface TxAllocation {
  id: number;
  service_month: YearMonth;
  payment_date: string;
  allocated_amount: number;
  contract_amount_snapshot: number;
  status: PaymentStatus;
  source: AllocationSource;
  month_status: PaymentStatus; // 현재 기준 해당 월 상태
}

export interface TransactionRow {
  id: number;
  import_batch_id: number;
  excel_row_number: number;
  bank_row_no: string | null;
  transaction_datetime: string;
  sender_raw: string;
  withdrawal_amount: number;
  deposit_amount: number;
  transaction_hash: string;
  created_at: string;
  filename: string;
  client_id: number | null;
  client_name: string | null;
  contract_amount: number | null;
  similarity_score: number;
  match_type: MatchType;
  match_status: MatchStatus;
  note: string | null;
  allocations: TxAllocation[];
}

export interface AuditLog {
  id: number;
  action: string;
  entity_type: string;
  entity_id: number | null;
  before_data: string | null;
  after_data: string | null;
  created_at: string;
}

export interface TransactionDetail {
  transaction: TransactionRow;
  candidates: MatchCandidate[];
  audit: AuditLog[];
}

export interface AdvisoryResponse {
  year: number;
  currentMonth: YearMonth;
  clients: Client[];
  allocations: (GridAllocation & { sender_raw: string | null; transaction_datetime: string | null })[];
}

export interface SyncStatus {
  lastSuccess: { created_at: string; client_count: number; message: string | null } | null;
  lastAttempt: { created_at: string; status: 'SUCCESS' | 'FAILED'; message: string | null } | null;
}

export interface SyncResult {
  ok: boolean;
  message: string;
  added: number;
  updated: number;
  deactivated: number;
  aliases: number;
  warnings: string[];
  status: SyncStatus;
}

export interface DashboardResponse {
  currentMonth: YearMonth;
  monthDeposit: number;
  monthWithdrawal: number;
  unmatchedCount: number;
  partialTxCount: number;
  unpaidClientCount: number;
  clientCount: number;
  lastImport: { filename: string; imported_at: string } | null;
}

export interface ImportBatch {
  id: number;
  filename: string;
  file_hash: string;
  total_rows: number;
  inserted_rows: number;
  duplicate_rows: number;
  imported_at: string;
  confirmed_rows: number;
}

export interface ClientsResponse {
  clients: Client[];
  aliases: (ClientAlias & { client_name: string })[];
}

// ---------- 기존 Excel(노무자문비) 가져오기 ----------
export interface LegacyPreviewRequest {
  clients: LegacyClientRow[];
  mapping?: Record<number, number | null>; // excelRowNumber → clientId
}
export interface LegacyPreviewRow extends LegacyClientRow {
  autoMatch: MatchResult;
  clientId: number | null;
  clientName: string | null;
  snapshotAmount: number | null;
  firstMonth: YearMonth | null;
  monthCount: number;
  existingMonths: number; // 이미 배정이 있는 월 (건너뜀)
  warnings: string[];
}
export interface LegacyPreviewResponse {
  rows: LegacyPreviewRow[];
}
export interface LegacyCommitResponse {
  clients: number;
  allocations: number;
  skippedMonths: number;
}

/** 개별건: 거래처에 매칭되지 않은 통장 입금 + 현재 기준 가장 비슷한 거래처 */
export interface IndividualCaseRow extends TransactionRow {
  bestCandidate: MatchCandidate | null;
  /** bestCandidate 유사도가 40% 이상 */
  similar: boolean;
  isGeneric: boolean;
}

export interface ExportResponse {
  year: number;
  currentMonth: YearMonth;
  transactions: TransactionRow[];
  individual: IndividualCaseRow[];
  advisory: AdvisoryResponse;
  clients: Client[];
  batches: ImportBatch[];
}
