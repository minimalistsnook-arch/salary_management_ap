import { buildMatchIndex, matchSender, type IndexAlias, type MatchIndex, type MatchResult } from '../../../src/domain/matching';
import { canLearnAlias, normalizeName } from '../../../src/domain/normalize';
import { all, nowIso, type SqlDb, type SqlStatement } from '../../db';
import { listClients } from '../../repos';

/** 활성 거래처 + alias 로 매칭 인덱스 구성 */
export async function loadMatchIndex(db: SqlDb): Promise<MatchIndex> {
  const [clients, aliases, exclusions] = await Promise.all([
    listClients(db, true),
    all<IndexAlias>(db, 'SELECT normalized_sender, client_id, raw_sender, source FROM client_aliases'),
    all<{ normalized_sender: string }>(db, 'SELECT normalized_sender FROM sender_exclusions'),
  ]);
  return buildMatchIndex(
    clients,
    aliases,
    exclusions.map((e) => e.normalized_sender),
  );
}

export function matchWithIndex(senderRaw: string, index: MatchIndex): MatchResult {
  return matchSender(senderRaw, index);
}

/**
 * 수동 확정한 통장 표기명을 alias 로 학습. CMS집금 등 공통 입금명은 저장하지 않는다.
 * 이미 등록된 표기명은 덮어쓰지 않는다(INSERT OR IGNORE).
 */
export function learnAliasStmt(db: SqlDb, senderRaw: string, clientId: number): SqlStatement | null {
  if (!canLearnAlias(senderRaw)) return null;
  return db
    .prepare("INSERT OR IGNORE INTO client_aliases (raw_sender, normalized_sender, client_id, source, created_at) VALUES (?, ?, ?, 'MANUAL', ?)")
    .bind(senderRaw.trim(), normalizeName(senderRaw), clientId, nowIso());
}

/**
 * 미확정 입금(미매칭·확인필요)의 추천 거래처를 현재 거래처/별칭 기준으로 다시 계산한다.
 * 추천(client_id)만 갱신하고 확정·배정은 하지 않는다. (거래처 시트 동기화 후 호출)
 */
export async function refreshPendingSuggestions(db: SqlDb): Promise<number> {
  const rows = await all<{ id: number; sender_raw: string; client_id: number | null; status: string }>(
    db,
    `SELECT t.id, t.sender_raw, m.client_id, m.status FROM bank_transactions t
     JOIN transaction_client_matches m ON m.transaction_id = t.id
     WHERE t.deposit_amount > 0 AND m.status IN ('UNMATCHED', 'REVIEW_REQUIRED')`,
  );
  if (!rows.length) return 0;
  const index = await loadMatchIndex(db);
  const now = nowIso();
  const stmts: SqlStatement[] = [];
  for (const r of rows) {
    const res = matchSender(r.sender_raw, index);
    if (res.clientId == null || res.clientId === r.client_id) continue;
    stmts.push(
      db
        .prepare(
          `UPDATE transaction_client_matches SET client_id = ?, similarity_score = ?, match_type = ?, status = 'REVIEW_REQUIRED', updated_at = ?
           WHERE transaction_id = ? AND status IN ('UNMATCHED', 'REVIEW_REQUIRED')`,
        )
        .bind(res.clientId, Math.max(0, Math.min(100, res.score)), res.matchType, now, r.id),
    );
  }
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}
