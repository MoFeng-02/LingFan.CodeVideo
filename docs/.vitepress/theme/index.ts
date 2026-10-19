/**
 * 主题入口：扩展 VitePress 默认主题，注册文档站的自定义演示组件与品牌样式。
 *
 * 组件在 Markdown 里按全局名使用（<HeroEngine /> / <TimeProbe />），
 * 不需要每页手动 import。
 */
import DefaultTheme from "vitepress/theme";
import HeroEngine from "../components/HeroEngine.vue";
import TimeProbe from "../components/TimeProbe.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }: { app: { component(name: string, comp: unknown): void } }) {
    app.component("HeroEngine", HeroEngine);
    app.component("TimeProbe", TimeProbe);
  },
};
