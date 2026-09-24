/**
 * D1 호환 최소 인터페이스. 운영은 Cloudflare D1, 테스트는 node:sqlite 어댑터를 사용한다.
 */
export interface SqlRunResult {
  meta: { last_row_id?: number; changes?: number };
}
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<SqlRunResult>;
}
export interface SqlDb {
  prepare(sql: string): SqlStatement;
  /** 원자적 실행 (하나라도 실패하면 전체 롤백) */
  batch(statements: SqlStatement[]): Promise<unknown[]>;
}

export async function all<T>(db: SqlDb, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}

export async function first<T>(db: SqlDb, sql: string, ...params: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** SQLite IN (?, ?, ...) 자리표시자 */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/** 도메인 오류 → HTTP 400 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
