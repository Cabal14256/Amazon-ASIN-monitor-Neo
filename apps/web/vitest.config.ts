import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    environmentOptions: { jsdom: { url: 'https://app.test/' } },
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
