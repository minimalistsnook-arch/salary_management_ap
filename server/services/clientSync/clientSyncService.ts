import { interpretClientSheet } from '../../../src/domain/clientSheet';
import type { SyncResult, SyncStatus } from '../../../src/domain/dto';
import { isGenericSender, normalizeName } from '../../../src/domain/normalize';
import type { Client } from '../../../src/domain/types';
import { auditStmt } from '../../audit';
import { all, first, nowIso, type SqlDb, type SqlStatement } from '../../db';
import { listClients } from '../../repos';
import type { ClientSourceAdapter } from './adapters';

export async function getSyncStatus(db: SqlDb): Promise<SyncStatus> {
  const lastSuccess = await first<{ created_at: string; client_count: number; message: string | null }>(
    db,
    "SELECT created_at, client_count, message FROM sync_logs WHERE status = 'SUCCESS' ORDER BY id DESC LIMIT 1",
  );
  const lastAttempt = await first<{ created_at: string; status: 'SUCCESS' | 'FAILED'; message: string | null }>(db, 'SELECT created_at, status, message FROM sync_logs ORDER BY id DESC LIMIT 1');
  return { lastSuccess, lastAttempt };
}

async function logFailure(db: SqlDb, source: string, message: string): Promise<SyncResult> {
  await db.prepare("INSERT INTO sync_logs (source, status, message, client_count, created_at) VALUES (?, 'FAILED', ?, 0, ?)").bind(source, message, nowIso()).run();
  return { ok: false, message, added: 0, updated: 0, deactivated: 0, aliases: 0, warnings: [], status: await getSyncStatus(db) };
}

/**
 * [거래처 정보 새로고침]
 * - 실패 시 기존 거래처 데이터는 그대로 유지하고 실패 로그만 남긴다.
 * - 시트에서 사라진 거래처는 삭제하지 않고 active=0 처리 (과거 거래 보존).
 * - 계약금액 변경은 current_contract_amount 만 갱신. 과거 배정은 snapshot 으로 유지된다.
 */
export async function syncClients(db: SqlDb, adapter: ClientSourceAdapter): Promise<SyncResult> {
  let rows: string[][];
  try {
    rows = await adapter.fetchRows();
  } catch (e) {
    return logFailure(db, adapter.name, `거래처 정보를 불러오지 못했습니다: ${(e as Error).message}`);
  }
  const sheet = interpretClientSheet(rows);
  const existing = await listClients(db);
  const activeCount = existing.filter((c) => c.active).length;
  if (sheet.clients.length === 0) return logFailure(db, adapter.name, '시트에서 거래처를 한 건도 읽지 못했습니다. (B열=거래처명, C열=계약금액)');
  // 안전장치: 시트가 깨져서 거래처가 급감하면 반영하지 않는다
  if (activeCount >= 10 && sheet.clients.length < activeCount * 0.5) {
    return logFailure(db, adapter.name, `시트 거래처 수(${sheet.clients.length})가 기존 활성 거래처(${activeCount})의 절반 미만이라 반영하지 않았습니다.`);
  }

  const now = nowIso();
  const byName = new Map<string, Client>(existing.map((c) => [c.name, c]));
  const sheetNames = new Set(sheet.clients.map((c) => c.name));
  const stmts: SqlStatement[] = [];
  let added = 0;
  let updated = 0;
  let deactivated = 0;

  for (const sc of sheet.clients) {
    const cur = byName.get(sc.name);
    if (!cur) {
      added++;
      stmts.push(
        db
          .prepare('INSERT INTO clients (name, current_contract_amount, source_row, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
          .bind(sc.name, sc.contractAmount, sc.sourceRow, now, now),
      );
      continue;
    }
    if (cur.current_contract_amount !== sc.contractAmount || cur.source_row !== sc.sourceRow || !cur.active) {
      updated++;
      stmts.push(
        db.prepare('UPDATE clients SET current_contract_amount = ?, source_row = ?, active = 1, updated_at = ? WHERE id = ?').bind(sc.contractAmount, sc.sourceRow, now, cur.id),
      );
      if (cur.current_contract_amount !== sc.contractAmount || !cur.active) {
        stmts.push(
          auditStmt(
            db,
            'SYNC_UPDATE_CLIENT',
            'client',
            cur.id,
            { current_contract_amount: cur.current_contract_amount, active: cur.active },
            { current_contract_amount: sc.contractAmount, active: 1 },
          ),
        );
      }
    }
  }
  for (const c of existing) {
    if (c.active && !sheetNames.has(c.name)) {
      deactivated++;
      stmts.push(db.prepare('UPDATE clients SET active = 0, updated_at = ? WHERE id = ?').bind(now, c.id));
      stmts.push(auditStmt(db, 'SYNC_DEACTIVATE_CLIENT', 'client', c.id, { active: 1 }, { active: 0 }));
    }
  }

  // 시트 A열 별칭 (공통 입금명 제외, 수동 별칭은 덮어쓰지 않음)
  const aliasRows = await all<{ normalized_sender: string }>(db, 'SELECT normalized_sender FROM client_aliases');
  const aliasSet = new Set(aliasRows.map((a) => a.normalized_sender));
  let aliases = 0;
  for (const al of sheet.aliases) {
    const n = normalizeName(al.rawSender);
    if (!n || isGenericSender(al.rawSender) || aliasSet.has(n)) continue;
    aliasSet.add(n);
    aliases++;
    stmts.push(
      db
        .prepare("INSERT OR IGNORE INTO client_aliases (raw_sender, normalized_sender, client_id, source, created_at) VALUES (?, ?, (SELECT id FROM clients WHERE name = ?), 'SHEET', ?)")
        .bind(al.rawSender, n, al.clientName, now),
    );
  }

  const message = `추가 ${added} · 변경 ${updated} · 비활성 ${deactivated} · 별칭 ${aliases}`;
  stmts.push(db.prepare("INSERT INTO sync_logs (source, status, message, client_count, created_at) VALUES (?, 'SUCCESS', ?, ?, ?)").bind(adapter.name, message, sheet.clients.length, now));
  try {
    await db.batch(stmts);
  } catch (e) {
    return logFailure(db, adapter.name, `저장 중 오류가 발생해 변경사항을 반영하지 않았습니다: ${(e as Error).message}`);
  }
  return { ok: true, message, added, updated, deactivated, aliases, warnings: sheet.warnings, status: await getSyncStatus(db) };
}
