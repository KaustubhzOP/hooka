import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5173, host: 'localhost' },
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
  build: { chunkSizeWarningLimit: 1200 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' }
});
