import { handleApi, type Env } from '../../server/router';

// Cloudflare Pages Functions: /api/* 전체를 서버 라우터로 전달
export const onRequest: PagesFunction<Env> = ({ request, env }) => handleApi(request, env);
