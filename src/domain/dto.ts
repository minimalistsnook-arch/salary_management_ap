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
  /** 계약금액의 여러 배(4개월분 이상) 입금 */
  amountWarning: string | null;
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

export interface BulkActionRequest {
  action: 'confirm' | 'redate' | 'unassign';
  ids: number[];
  /** 지정 거래처 (없으면 각 거래의 추천 거래처) */
  clientId?: number | null;
  /** confirm: 관리 시작월 없는 거래처의 첫 적용월 / redate: 다시 배정할 시작월 */
  startMonth?: YearMonth | null;
  /** confirm: 수수료 차감 가능성·큰 금액 경고 건도 확정 (기본은 건너뜀) */
  includeWarnings?: boolean;
}

export interface BulkActionResult {
  done: number;
  skipped: { id: number; reason: string }[];
  failed: { id: number; error: string }[];
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
  /** 시트에서 x(제외) 표시된 입금처 */
  excluded: boolean;
}

// ---------- 마지막 입금 기준표 ----------
export interface BaselinePreviewRow {
  line: number;
  seq: string;
  name: string;
  clientId: number | null;
  clientName: string | null;
  lastMonth: YearMonth | null;
  lastDate: string | null;
  /** BASELINE: 반영, NO_RECORD: 입금기록 없음(부가정보만), NO_CLIENT: 거래처를 찾지 못함 */
  mode: 'BASELINE' | 'NO_RECORD' | 'NO_CLIENT';
  /** 통장에 해당 날짜 입금이 없어 기존 기록으로 남기는 월분 */
  baselineRecord: { month: YearMonth; date: string; amount: number } | null;
  deposits: { id: number; date: string; sender: string; amount: number; wasConfirmed: boolean; before: YearMonth[]; after: YearMonth[] }[];
  startMonth: YearMonth | null;
  warnings: string[];
}
export interface BaselinePreviewResponse {
  reference: string;
  errors: string[];
  rows: BaselinePreviewRow[];
}
export interface BaselineApplyResult {
  clients: number;
  baselineRecords: number;
  deposits: number;
  allocations: number;
  metaOnly: number;
  skipped: number;
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
