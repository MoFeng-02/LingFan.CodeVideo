/**
 * 浏览器示例的会话态：唯一的一份 DOM 引用、尺寸常量与 HUD 文案。
 *
 * 预览、定格、导出三条消费端都读写这里的 `session` 与 `warm`；
 * 页面元素与成片尺寸只在这一处声明，其他模块只引用，不各自抓 DOM。
 */

/** 成片尺寸：交付物固定 1920×1080。 */
export const WIDTH = 1920;
export const HEIGHT = 1080;

/** 预览尺寸：屏幕上那块画布按显示大小渲染，不跟着成片尺寸烧显卡。 */
export const PREVIEW_W = 1280;
export const PREVIEW_H = 720;

/** 导出容器的基准采样率：镜头采样密度由剧本逐段声明，这里只定容器。 */
export const BASE_FPS = 30;

export const stage = document.getElementById("stage") as HTMLCanvasElement;
stage.width = PREVIEW_W;
stage.height = PREVIEW_H;

export const hud = document.getElementById("hud") as HTMLDivElement;
export const playBtn = document.getElementById("play") as HTMLButtonElement;
export const exportBtn = document.getElementById("export") as HTMLButtonElement;

/** 互斥标记与暂停开关：三条消费端共享，防止同时开两次推演。 */
export const session = { busy: false, paused: false };

/** 音频预热进度：只用于 HUD 文案。 */
export const warm = { done: 0, total: 0, failed: false, urgent: false };

/** 未播放时的 HUD：空闲问候 / 预热进度。 */
export function paintIdleHud(): void {
  if (session.busy) return;
  if (warm.total === 0) {
    hud.textContent = "点「播放」开始（音频需用户手势解锁）";
    return;
  }
  hud.textContent =
    warm.done < warm.total
      ? `预热音轨 ${warm.done}/${warm.total} · 可以先点播放`
      : warm.failed
        ? "预热未完成，播放时会重试"
        : "就绪 · 点「播放」开始";
}
