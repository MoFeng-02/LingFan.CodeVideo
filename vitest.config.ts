import { defineConfig } from 'vitest/config';

// 测试集中根 tests/，不与源码同置
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
