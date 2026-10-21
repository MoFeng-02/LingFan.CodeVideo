/**
 * 浏览器示例入口：只做接线——按钮、定格参数、HUD 首屏。
 *
 * 文件分工：
 * - `session.ts`：DOM 引用、尺寸、互斥标记、预热进度；
 * - `host.ts`：把层声明配成宿主（三维 z0 + 文字 z10）；
 * - `playback.ts` / `export.ts` / `export-alpha.ts`：预览、定格、三条出片路径。
 */
import { exportMp4 } from "./export";
import { exportAlphaApng, exportAlphaWebm } from "./export-alpha";
import { runStill, togglePlay } from "./playback";
import {
  exportApngBtn,
  exportBtn,
  exportWebmBtn,
  paintIdleHud,
  playBtn,
} from "./session";

playBtn.addEventListener("click", () => {
  togglePlay();
});
exportBtn.addEventListener("click", () => {
  void exportMp4();
});
exportApngBtn.addEventListener("click", () => {
  void exportAlphaApng();
});
exportWebmBtn.addEventListener("click", () => {
  void exportAlphaWebm();
});

playBtn.disabled = false;
playBtn.textContent = "播放";
paintIdleHud();

// 定格模式（调试用）：`?t=<毫秒>` 只推到那一帧就停。
const stillAt = Number(new URLSearchParams(location.search).get("t"));
if (Number.isFinite(stillAt) && stillAt > 0) void runStill(stillAt);
