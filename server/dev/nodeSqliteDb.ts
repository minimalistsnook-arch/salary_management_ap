/**
 * 로컬 개발/테스트용: node:sqlite 로 D1 인터페이스를 구현한다.
 * (운영은 Cloudflare D1. 같은 migrations/*.sql 을 사용)
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SqlDb, SqlStatement } from '../db';

type Param = null | number | bigint | string | Uint8Array;
const norm = (v: unknown): Param => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as Param));

/** 적용되지 않은 migration 만 순서대로 실행 */
export function applyMigrations(raw: DatabaseSync, dir = join(process.cwd(), 'migrations')): string[] {
  raw.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((raw.prepare('SELECT name FROM _local_migrations').all() as { name: string }[]).map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    raw.exec('BEGIN');
    try {
      raw.exec(readFileSync(join(dir, f), 'utf8'));
      raw.prepare('INSERT INTO _local_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
      raw.exec('COMMIT');
      applied.push(f);
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
  }
  return applied;
}

export function createSqliteDb(path = ':memory:'): SqlDb & { raw: DatabaseSync } {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON');
  applyMigrations(raw);

  // Cloudflare D1 과 같은 제한: 쿼리당 바인딩 변수 최대 100개
  const makeStmt = (sql: string, params: unknown[] = []): SqlStatement & { exec(): unknown } => ({
    bind: (...v: unknown[]) => {
      if (v.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${v.length} > 100)`);
      return makeStmt(sql, v);
    },
    all: async <T>() => ({ results: raw.prepare(sql).all(...params.map(norm)) as T[] }),
    first: async <T>() => (raw.prepare(sql).get(...params.map(norm)) as T) ?? null,
    run: async () => {
      const r = raw.prepare(sql).run(...params.map(norm));
      return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
    },
    exec: () => raw.prepare(sql).run(...params.map(norm)),
  });

  return {
    raw,
    prepare: (sql: string) => makeStmt(sql),
    // D1 batch 와 같이 원자적으로 실행
    batch: async (stmts: SqlStatement[]) => {
      raw.exec('BEGIN');
      try {
        const out = stmts.map((s) => (s as unknown as { exec(): unknown }).exec());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
