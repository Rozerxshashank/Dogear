import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['renderer/src/**/*.test.ts', 'renderer/src/**/*.test.tsx', 'src/**/*.test.ts'],
  },
});
