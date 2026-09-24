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
