import tseslint from "typescript-eslint";

/**
 * 最小化类型感知 ESLint：只补 tsc 抓不到的 async/promise 类缺陷。
 * 不启用 recommended 规则集，不引入格式/风格规则（格式由 prettier 负责，
 * 类型与未使用符号由 tsc 负责），因此这里仅三条与类型信息绑定的规则。
 */

/** 作用范围：三个包源码 + 根级测试与示例。 */
const typedSources = [
  "packages/*/src/**/*.ts",
  "tests/**/*.ts",
  "examples/**/*.ts",
];

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  {
    files: typedSources,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // 由每个文件所属的 tsconfig 提供类型信息（packages 各自 include src，
        // 根 tsconfig 覆盖 tests/examples），无需逐个手写 project 列表。
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
];
