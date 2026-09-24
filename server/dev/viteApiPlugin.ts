/**
 * 로컬 개발용 Vite 플러그인: /api/* 를 Cloudflare Pages Function 과 같은 router(server/router.ts)로 처리한다.
 * DB 는 .data/local.sqlite (node:sqlite) 에 저장되어 새로고침·재시작 후에도 유지된다.
 * wrangler(workerd) 를 실행할 수 없는 환경(구버전 glibc Codespace 등)에서도 동작한다.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

function readVars(root: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const toml = join(root, 'wrangler.toml');
  if (existsSync(toml)) {
    let inVars = false;
    for (const line of readFileSync(toml, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.startsWith('[')) inVars = t === '[vars]';
      const m = inVars && /^(\w+)\s*=\s*"(.*)"/.exec(t);
      if (m) vars[m[1]] = m[2];
    }
  }
  const devVars = join(root, '.dev.vars');
  if (existsSync(devVars)) {
    for (const line of readFileSync(devVars, 'utf8').split('\n')) {
      const m = /^\s*(\w+)\s*=\s*"?(.*?)"?\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) vars[m[1]] = m[2];
    }
  }
  for (const k of Object.keys(vars)) if (process.env[k]) vars[k] = process.env[k] as string;
  return vars;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export function localApiPlugin(): Plugin {
  let env: Record<string, unknown> | null = null;
  const getEnv = async (server: ViteDevServer) => {
    if (env) return env;
    const { createSqliteDb } = (await server.ssrLoadModule('/server/dev/nodeSqliteDb.ts')) as typeof import('./nodeSqliteDb');
    const dbPath = process.env.LOCAL_DB_PATH ?? join(server.config.root, '.data', 'local.sqlite');
    env = { ...readVars(server.config.root), DB: createSqliteDb(dbPath) };
    server.config.logger.info(`[local-api] SQLite DB: ${dbPath}`);
    return env;
  };

  return {
    name: 'local-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        try {
          const { handleApi } = (await server.ssrLoadModule('/server/router.ts')) as typeof import('../router');
          const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
          const request = new Request(`http://localhost${req.url}`, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body: body && body.length ? new Uint8Array(body) : undefined,
          });
          const response = await handleApi(request, (await getEnv(server)) as never);
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (e) {
          server.config.logger.error(`[local-api] ${(e as Error).stack ?? e}`);
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: '로컬 API 오류', details: String(e) }));
        }
      });
    },
  };
}
