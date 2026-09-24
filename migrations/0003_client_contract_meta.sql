-- 노무자문비 양식용 거래처 부가 정보 (기존 '노무자문비' 시트 가져오기 시 채움)
ALTER TABLE clients ADD COLUMN contract_start TEXT;     -- 계약기간 시작
ALTER TABLE clients ADD COLUMN contract_end TEXT;       -- 계약기간 종료
ALTER TABLE clients ADD COLUMN contract_type TEXT;      -- 계약형태 (CMS / 통장입금)
ALTER TABLE clients ADD COLUMN expected_pay_day TEXT;   -- 입금예상일 (20 / 말일 등)
ALTER TABLE clients ADD COLUMN manager TEXT;            -- 담당
ALTER TABLE clients ADD COLUMN legacy_seq TEXT;         -- 기존 시트 연번
