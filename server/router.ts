import { isYearMonth } from '../src/domain/month';
import { auditStmt } from './audit';
import { AppError, first, nowIso, type SqlDb } from './db';
import { getClient, listAliases, listClients } from './repos';
import { ensureSchema } from './schemaGuard';
import { buildPreview, commitImport } from './services/bankImport/bankImportService';
import { createClientSourceAdapter, type ClientSourceEnv } from './services/clientSync/adapters';
import { getSyncStatus, syncClients } from './services/clientSync/clientSyncService';
import { commitLegacy, previewLegacy } from './services/legacyImport/legacyImportService';
import { applyBaseline, previewBaseline } from './services/baseline/baselineService';
import { bulkTransactions } from './services/paymentAllocation/bulkService';
import { assignTransaction, setManualAllocations, unassignTransaction, updateNote } from './services/paymentAllocation/allocationService';
import { advisoryData, dashboard, exportData, individualCases, listBatches, listTransactions, transactionDetail } from './services/query/queryService';

export interface Env extends ClientSourceEnv {
  DB: SqlDb;
}

type Handler = (ctx: { db: SqlDb; env: Env; params: string[]; url: URL; body: () => Promise<any> }) => Promise<unknown>;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const int = (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError('잘못된 ID 입니다.');
  return n;
};
const yearParam = (url: URL) => {
  const y = Number(url.searchParams.get('year') ?? new Date().getFullYear());
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new AppError('연도가 올바르지 않습니다.');
  return y;
};

const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/dashboard$/, ({ db }) => dashboard(db)],
  // 거래처
  ['GET', /^\/api\/clients$/, async ({ db }) => ({ clients: await listClients(db), aliases: await listAliases(db) })],
  ['POST', /^\/api\/clients\/sync$/, async ({ db, env }) => {
    let adapter;
    try {
      adapter = createClientSourceAdapter(env);
    } catch (e) {
      await db.prepare("INSERT INTO sync_logs (source, status, message, client_count, created_at) VALUES ('config', 'FAILED', ?, 0, ?)").bind((e as Error).message, nowIso()).run();
      return { ok: false, message: (e as Error).message, added: 0, updated: 0, deactivated: 0, aliases: 0, warnings: [], status: await getSyncStatus(db) };
    }
    return syncClients(db, adapter);
  }],
  ['GET', /^\/api\/clients\/sync-status$/, ({ db }) => getSyncStatus(db)],
  ['PATCH', /^\/api\/clients\/(\d+)$/, async ({ db, params, body }) => {
    const id = int(params[0]);
    const b = await body();
    const client = await getClient(db, id);
    if (!client) throw new AppError('거래처를 찾을 수 없습니다.', 404);
    const month = b.management_start_month === '' ? null : b.management_start_month;
    if (month !== null && !isYearMonth(month)) throw new AppError('관리 시작월은 YYYY-MM 형식이어야 합니다.');
    await db.batch([
      db.prepare('UPDATE clients SET management_start_month = ?, updated_at = ? WHERE id = ?').bind(month, nowIso(), id),
      auditStmt(db, 'SET_START_MONTH', 'client', id, { management_start_month: client.management_start_month }, { management_start_month: month }),
    ]);
    return getClient(db, id);
  }],
  ['DELETE', /^\/api\/aliases\/(\d+)$/, async ({ db, params }) => {
    const id = int(params[0]);
    const alias = await first(db, 'SELECT * FROM client_aliases WHERE id = ?', id);
    if (!alias) throw new AppError('별칭을 찾을 수 없습니다.', 404);
    await db.batch([db.prepare('DELETE FROM client_aliases WHERE id = ?').bind(id), auditStmt(db, 'DELETE_ALIAS', 'alias', id, alias, null)]);
    return { ok: true };
  }],
  // 통장 업로드
  ['POST', /^\/api\/imports\/preview$/, async ({ db, body }) => buildPreview(db, await body())],
  ['POST', /^\/api\/imports\/commit$/, async ({ db, body }) => commitImport(db, await body())],
  ['GET', /^\/api\/imports$/, ({ db }) => listBatches(db)],
  // 거래
  ['GET', /^\/api\/transactions$/, ({ db, url }) => listTransactions(db, url.searchParams.get('year') ? yearParam(url) : undefined)],
  ['POST', /^\/api\/transactions\/bulk$/, async ({ db, body }) => bulkTransactions(db, await body())],
  ['GET', /^\/api\/transactions\/(\d+)$/, ({ db, params }) => transactionDetail(db, int(params[0]))],
  ['POST', /^\/api\/transactions\/(\d+)\/assign$/, async ({ db, params, body }) => {
    const b = await body();
    return assignTransaction(db, int(params[0]), { clientId: int(String(b.clientId)), startMonth: b.startMonth || null, note: b.note, learnAlias: b.learnAlias });
  }],
  ['POST', /^\/api\/transactions\/(\d+)\/allocations$/, async ({ db, params, body }) => {
    const b = await body();
    if (!Array.isArray(b.lines)) throw new AppError('배정 내역이 없습니다.');
    return setManualAllocations(db, int(params[0]), { lines: b.lines, note: b.note });
  }],
  ['POST', /^\/api\/transactions\/(\d+)\/unassign$/, async ({ db, params }) => {
    await unassignTransaction(db, int(params[0]));
    return { ok: true };
  }],
  ['POST', /^\/api\/transactions\/(\d+)\/note$/, async ({ db, params, body }) => {
    const b = await body();
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 1000) : null;
    await updateNote(db, int(params[0]), note);
    return { ok: true };
  }],
  // 개별건 (매칭되지 않은 입금)
  ['GET', /^\/api\/individual$/, ({ db, url }) => individualCases(db, url.searchParams.get('year') ? yearParam(url) : undefined)],
  // 노무자문비
  ['GET', /^\/api\/advisory$/, ({ db, url }) => advisoryData(db, yearParam(url))],
  ['POST', /^\/api\/baseline\/preview$/, async ({ db, body }) => previewBaseline(db, await body())],
  ['POST', /^\/api\/baseline\/apply$/, async ({ db, body }) => applyBaseline(db, await body())],
  ['POST', /^\/api\/legacy\/preview$/, async ({ db, body }) => previewLegacy(db, await body())],
  ['POST', /^\/api\/legacy\/commit$/, async ({ db, body }) => commitLegacy(db, await body())],
  // 전체 Excel 추출용 데이터
  ['GET', /^\/api\/export$/, ({ db, url }) => exportData(db, yearParam(url))],
];

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: 'D1 데이터베이스(DB 바인딩)가 연결되지 않았습니다.' }, 500);
  try {
    await ensureSchema(env.DB);
  } catch (e) {
    return json({ error: 'DB 스키마를 확인할 수 없습니다. D1 migration 적용 여부를 확인해주세요.', details: String(e) }, 500);
  }
  for (const [method, re, handler] of routes) {
    const m = re.exec(url.pathname);
    if (!m || method !== request.method) continue;
    try {
      const data = await handler({
        db: env.DB,
        env,
        params: m.slice(1),
        url,
        body: async () => {
          try {
            return await request.json();
          } catch {
            throw new AppError('요청 본문(JSON)을 읽을 수 없습니다.');
          }
        },
      });
      return json(data ?? { ok: true });
    } catch (e) {
      if (e instanceof AppError) return json({ error: e.message, details: e.details ?? null }, e.status);
      console.error(e);
      const msg = (e as Error).message ?? String(e);
      if (/UNIQUE constraint failed/.test(msg)) return json({ error: '이미 등록된 데이터와 충돌하여 저장하지 않았습니다. 새로고침 후 다시 시도해주세요.', details: msg }, 409);
      return json({ error: '서버 오류가 발생했습니다.', details: msg }, 500);
    }
  }
  return json({ error: `API를 찾을 수 없습니다: ${request.method} ${url.pathname}` }, 404);
}
