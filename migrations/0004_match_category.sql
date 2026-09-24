-- 입금 분류: NULL(일반) | 'INDIVIDUAL'(개별건으로 확정) | 'DUPLICATE'(통장 중복 행 — 건너뜀, 원본만 보존)
ALTER TABLE transaction_client_matches ADD COLUMN category TEXT CHECK (category IS NULL OR category IN ('INDIVIDUAL', 'DUPLICATE'));
