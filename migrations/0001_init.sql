-- 노무 자문비 / 거래처 입출금 관리 초기 스키마
-- 모든 금액은 INTEGER(원 단위). 월은 'YYYY-MM' 텍스트.

-- 거래처 마스터 (Google Sheet B:C 동기화)
CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,                         -- Google Sheet의 정확한 거래처명
  current_contract_amount INTEGER NOT NULL DEFAULT 0 CHECK (current_contract_amount >= 0),
  management_start_month TEXT CHECK (management_start_month IS NULL OR management_start_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  source_row INTEGER,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 통장 표기명 → 거래처 alias (수동 확정 또는 시트 A열 매핑)
CREATE TABLE client_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_sender TEXT NOT NULL,
  normalized_sender TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'SHEET')),
  created_at TEXT NOT NULL
);

-- 통장 Excel 업로드 단위
CREATE TABLE bank_import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  file_hash TEXT NOT NULL UNIQUE,
  total_rows INTEGER NOT NULL DEFAULT 0,
  inserted_rows INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL
);

-- RAW: 통장 원본 거래 (수정 불가)
CREATE TABLE bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id INTEGER NOT NULL REFERENCES bank_import_batches(id),
  excel_row_number INTEGER NOT NULL,
  bank_row_no TEXT,                                  -- A열 번호 원본
  transaction_datetime TEXT NOT NULL,                -- 'YYYY-MM-DD HH:mm:ss'
  sender_raw TEXT NOT NULL,                          -- 통장 원본 보낸분/받는분
  withdrawal_amount INTEGER NOT NULL DEFAULT 0 CHECK (withdrawal_amount >= 0),
  deposit_amount INTEGER NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  transaction_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_bank_tx_datetime ON bank_transactions(transaction_datetime);

-- 원본 거래는 절대 수정하지 않는다
CREATE TRIGGER bank_transactions_no_update
BEFORE UPDATE ON bank_transactions
BEGIN
  SELECT RAISE(ABORT, 'bank_transactions is immutable');
END;

-- PROCESSED: 거래 ↔ 거래처 매칭 (거래당 1행)
CREATE TABLE transaction_client_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL UNIQUE REFERENCES bank_transactions(id),
  client_id INTEGER REFERENCES clients(id),          -- REVIEW_REQUIRED 일 때는 추천 거래처
  similarity_score INTEGER NOT NULL DEFAULT 0 CHECK (similarity_score BETWEEN 0 AND 100),
  match_type TEXT NOT NULL CHECK (match_type IN ('EXACT', 'FUZZY', 'ALIAS', 'MANUAL', 'NONE')),
  status TEXT NOT NULL CHECK (status IN ('AUTO_MATCHED', 'MANUAL_MATCHED', 'REVIEW_REQUIRED', 'UNMATCHED')),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_matches_client ON transaction_client_matches(client_id);

-- PROCESSED: 월분 배정 (당시 계약금액 snapshot 보존)
CREATE TABLE payment_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER REFERENCES bank_transactions(id),   -- LEGACY 는 NULL
  client_id INTEGER NOT NULL REFERENCES clients(id),
  service_month TEXT NOT NULL CHECK (service_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  payment_date TEXT NOT NULL,                        -- 'YYYY-MM-DD'
  allocated_amount INTEGER NOT NULL CHECK (allocated_amount > 0),
  contract_amount_snapshot INTEGER NOT NULL CHECK (contract_amount_snapshot >= 0),
  status TEXT NOT NULL CHECK (status IN ('UNPAID', 'PARTIAL', 'PAID')),  -- 배정 시점의 월 상태
  source TEXT NOT NULL DEFAULT 'BANK' CHECK (source IN ('BANK', 'MANUAL', 'LEGACY')),
  legacy_key TEXT UNIQUE,                            -- 기존 Excel 가져오기 중복 방지
  created_at TEXT NOT NULL
);
CREATE INDEX idx_alloc_client_month ON payment_allocations(client_id, service_month);
CREATE INDEX idx_alloc_tx ON payment_allocations(transaction_id);

-- 수정 이력
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  before_data TEXT,
  after_data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);

-- 거래처 동기화 로그 (실패 시에도 기존 데이터 유지)
CREATE TABLE sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
  message TEXT,
  client_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
