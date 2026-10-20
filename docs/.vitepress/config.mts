import { defineConfig } from "vitepress";

/**
 * 文档站配置（VitePress 1.x）。
 *
 * 部署目标：GitHub Pages 项目站点（MoFeng-02/LingFan.CodeVideo），
 * 站点挂在 `/LingFan.CodeVideo/` 子路径下——base 必须与之对齐；
 * 换自定义域名或用户站点时用环境变量 DOC_BASE 覆盖。
 */
const base = process.env.DOC_BASE ?? "/LingFan.CodeVideo/";

export default defineConfig({
  lang: "zh-CN",
  title: "LingFan CodeVideo",
  description: "确定性推演式视频引擎：画面是时间的函数，总时长是编译产物。",
  base,
  // README.md 是仓库浏览入口（GitHub 侧），不进文档站；站点入口是 index.md。
  srcExclude: ["**/README.md"],
  head: [
    ["meta", { name: "theme-color", content: "#4d6bfe" }],
    [
      "link",
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230b1020'/%3E%3Ccircle cx='16' cy='16' r='7' fill='%234d6bfe'/%3E%3C/svg%3E",
      },
    ],
  ],
  themeConfig: {
    nav: [
      { text: "指南", link: "/mental-model" },
      { text: "上手", link: "/guides/first-clip" },
      { text: "契约", link: "/contracts/" },
      { text: "速查", link: "/pitfalls" },
    ],
    sidebar: [
      {
        text: "开始",
        items: [
          { text: "心智模型", link: "/mental-model" },
          { text: "词汇表", link: "/glossary" },
        ],
      },
      {
        text: "上手指南",
        items: [
          { text: "第一段画面", link: "/guides/first-clip" },
          { text: "幕段链与过场", link: "/guides/compose-acts" },
          { text: "加声音", link: "/guides/add-audio" },
          { text: "出片 mp4", link: "/guides/export-mp4" },
          { text: "出透明产物", link: "/guides/export-alpha" },
          { text: "不出片验证", link: "/guides/debug-with-compute" },
        ],
      },
      {
        text: "契约",
        items: [
          { text: "总览", link: "/contracts/" },
          { text: "时间与采样", link: "/contracts/time" },
          { text: "幕与段", link: "/contracts/scene" },
          { text: "调度与消杀", link: "/contracts/scheduler" },
          { text: "反馈与错误", link: "/contracts/feedback" },
          { text: "音频", link: "/contracts/audio" },
          { text: "捕获", link: "/contracts/capture" },
          { text: "导出", link: "/contracts/export" },
          { text: "资产与输入", link: "/contracts/asset-input" },
        ],
      },
      {
        text: "速查",
        items: [{ text: "反例台账", link: "/pitfalls" }],
      },
    ],
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/MoFeng-02/LingFan.CodeVideo",
      },
    ],
    outline: [2, 3],
    footer: {
      message: "画面是时间的函数，总时长是编译产物。",
      copyright: "LingFan CodeVideo",
    },
  },
});
