import { nowIso, type SqlDb, type SqlStatement } from './db';

export function auditStmt(db: SqlDb, action: string, entityType: string, entityId: number | null, before: unknown, after: unknown): SqlStatement {
  return db
    .prepare('INSERT INTO audit_logs (action, entity_type, entity_id, before_data, after_data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(action, entityType, entityId, before === undefined || before === null ? null : JSON.stringify(before), after === undefined || after === null ? null : JSON.stringify(after), nowIso());
}

/** entity_id 를 서브쿼리로 지정 (같은 batch 에서 막 생성된 행) */
export function auditStmtSub(db: SqlDb, action: string, entityType: string, idSubquery: string, subParams: unknown[], after: unknown): SqlStatement {
  return db
    .prepare(`INSERT INTO audit_logs (action, entity_type, entity_id, before_data, after_data, created_at) VALUES (?, ?, (${idSubquery}), NULL, ?, ?)`)
    .bind(action, entityType, ...subParams, JSON.stringify(after), nowIso());
}
