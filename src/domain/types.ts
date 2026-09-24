export type MatchStatus = 'AUTO_MATCHED' | 'MANUAL_MATCHED' | 'REVIEW_REQUIRED' | 'UNMATCHED';
export type MatchType = 'EXACT' | 'FUZZY' | 'ALIAS' | 'MANUAL' | 'NONE';
export type PaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID';
export type AllocationSource = 'BANK' | 'MANUAL' | 'LEGACY';

/** 'YYYY-MM' */
export type YearMonth = string;

export interface Client {
  id: number;
  name: string;
  current_contract_amount: number;
  management_start_month: YearMonth | null;
  source_row: number | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface ClientAlias {
  id: number;
  raw_sender: string;
  normalized_sender: string;
  client_id: number;
  source: 'MANUAL' | 'SHEET';
  created_at: string;
}

export interface PaymentAllocation {
  id: number;
  transaction_id: number | null;
  client_id: number;
  service_month: YearMonth;
  payment_date: string;
  allocated_amount: number;
  contract_amount_snapshot: number;
  status: PaymentStatus;
  source: AllocationSource;
  created_at: string;
}
