import { defineConfig } from 'vitest/config';

// 测试集中根 tests/，不与源码同置（agent.md 裁定、宪法 L42/L200）
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
