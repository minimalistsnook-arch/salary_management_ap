import type { SqlDb } from './db';

/**
 * 원격 D1 에 최신 migration 이 아직 적용되지 않았을 때를 대비한 안전장치.
 * 추가 테이블만 IF NOT EXISTS 로 만든다 (migrations/*.sql 과 같은 정의).
 */
const RUNTIME_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sender_exclusions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_sender TEXT NOT NULL,
    normalized_sender TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL DEFAULT 'SHEET' CHECK (source IN ('SHEET', 'MANUAL')),
    created_at TEXT NOT NULL
  )`,
];

const ensured = new WeakSet<object>();

export async function ensureSchema(db: SqlDb): Promise<void> {
  if (ensured.has(db)) return;
  for (const sql of RUNTIME_SCHEMA) await db.prepare(sql).run();
  ensured.add(db);
}
