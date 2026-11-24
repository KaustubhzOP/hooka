import { defineConfig } from 'vitest/config';

export default defineConfig({
  // allowedHosts: lets a temporary Cloudflare tunnel (https://…trycloudflare.com) reach the dev server,
  // so you can test on a phone before deploying (see README → Testing on a phone).
  server: { port: 5173, host: 'localhost', allowedHosts: ['.trycloudflare.com'] },
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
  build: { chunkSizeWarningLimit: 1200 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' }
});
