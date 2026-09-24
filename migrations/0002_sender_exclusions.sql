-- 거래처 시트에서 A열 입금처 + B열 'x' 로 표시된 '거래처 아님' 목록
CREATE TABLE IF NOT EXISTS sender_exclusions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_sender TEXT NOT NULL,
  normalized_sender TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'SHEET' CHECK (source IN ('SHEET', 'MANUAL')),
  created_at TEXT NOT NULL
);
