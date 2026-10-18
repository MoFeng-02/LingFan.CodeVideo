/**
 * 浏览器示例入口：只做接线——按钮、定格参数、HUD 首屏。
 *
 * 三件事分别落在相邻文件里：
 * - `session.ts`：DOM 引用、尺寸、互斥标记、预热进度；
 * - `host.ts`：把层声明配成宿主（三维 z0 + 文字 z10）；
 * - `playback.ts` / `export.ts`：预览、定格、导出三条消费端。
 */
import { exportMp4 } from "./export";
import { runStill, togglePlay } from "./playback";
import { exportBtn, paintIdleHud, playBtn } from "./session";

playBtn.addEventListener("click", () => {
  togglePlay();
});
exportBtn.addEventListener("click", () => {
  void exportMp4();
});

playBtn.disabled = false;
playBtn.textContent = "播放";
paintIdleHud();

// 定格模式（调试用）：`?t=<毫秒>` 只推到那一帧就停。
const stillAt = Number(new URLSearchParams(location.search).get("t"));
if (Number.isFinite(stillAt) && stillAt > 0) void runStill(stillAt);
