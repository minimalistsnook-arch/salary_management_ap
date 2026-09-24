/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { localApiPlugin } from './server/dev/viteApiPlugin';

// https://vitejs.dev/config/
export default defineConfig({
  // /api/* : 개발 중에는 localApiPlugin(node:sqlite), 배포 시에는 Cloudflare Pages Functions(D1)
  plugins: [react(), tailwindcss(), localApiPlugin()],
  server: { port: 3000 },
  test: {
    globals: true,
    environment: 'node',
  },
});
