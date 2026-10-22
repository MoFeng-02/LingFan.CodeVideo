/**
 * 透明产物：把同一份推演封成带 alpha 的成片或动图。
 *
 * 与 mp4 那条路的差别只有三处，其余（剧本、层、采样、合成）完全共用：
 * - 声明 `alpha: "alpha"`：引擎据此让合成器从全透明起手，未被画到的像素留在 0；
 * - 帧来源换成 `createReadbackHost`：透明编码要逐像素 alpha，拿到的是位图而不是句柄；
 * - 导出器换成保 alpha 的封装（`ApngExporter` / 带 alpha 的 `WebmExporter`）。
 *
 * 走的是**整片**，与 mp4 那条一样：不裁片段、不换剧本骨架。剧本里只少一层——
 * 遮罩（`makeMaterialStage`）。素材要叠在别人的画面上，铺满整幅的暗底会把 alpha 填死。
 *
 * 合成器两档都能用：回读对任何画布都成立（2D 直读，WebGL 先拷进接收画布再读），
 * 所以这里和 mp4 一样先给 GPU 档、失败退 CPU。
 */
import { render } from "@lingfan-video/core";
import {
  ApngExporter,
  WebmExporter,
  createCanvas2dCompositor,
  createReadbackHost,
} from "@lingfan-video/infra";
import { createThreeCompositor } from "@lingfan-video/infra/frames/adapters/three-compositor";

import { beginExport, endExport, saveBlob } from "./export-ui";
import { makeMaterialStage } from "./host";
import {
  ALPHA_H,
  ALPHA_W,
  BASE_FPS,
  exportApngBtn,
  exportWebmBtn,
  hud,
} from "./session";

/**
 * 合成器候选：与 mp4 那条路同一份顺序——先 GPU 档（合成结果直接进编码器），
 * 拿不到再退 CPU 档。透明档不改变这个选择，回读对两档都成立。
 */
const COMPOSITORS = [
  () => createThreeCompositor(),
  () => createCanvas2dCompositor(),
] as const;

/**
 * 造一套透明出片用的装配：独立画布 + 不带遮罩的剧本 + 位图回读。
 *
 * 画布每次新造：上一轮的残留会让「直接出片」与「先预览再出片」得到不同像素。
 *
 * @returns 合成宿主、包成位图的帧来源，以及整条片
 */
function makeAlphaStage() {
  const canvas = document.createElement("canvas");
  canvas.width = ALPHA_W;
  canvas.height = ALPHA_H;
  const stage = makeMaterialStage(canvas, ALPHA_W, ALPHA_H, {
    compositors: COMPOSITORS,
  });
  return {
    canvas,
    host: stage.host,
    painter: createReadbackHost(stage.host),
    scene: stage.program.picture,
  };
}

/**
 * 导出透明 APNG：逐帧保 alpha 的单文件动图，无音轨。
 *
 * 这条路的产物是素材（叠进别的片子或设计稿），不是带音轨的成片；
 * APNG 没有音轨，因此不需要混音时钟——剧本里的声音照常推演，只是不落盘。
 */
export async function exportAlphaApng(): Promise<void> {
  if (!beginExport(exportApngBtn, "编码透明 APNG…")) return;
  try {
    const { canvas, host, painter, scene } = makeAlphaStage();
    const exporter = new ApngExporter({ width: ALPHA_W, height: ALPHA_H });
    const result = await render(scene, {
      fps: BASE_FPS,
      width: ALPHA_W,
      height: ALPHA_H,
      canvas,
      exporter,
      alpha: "alpha",
      painter,
      onProgress: (done) => {
        hud.textContent = `导出 APNG ${done} 帧…（合成后端 ${host.compositorId ?? "探测中"}）`;
      },
    });
    const blob = result.output?.output;
    if (!(blob instanceof Blob)) throw new Error("导出器未返回 Blob");
    saveBlob(blob, "ledger-alpha.png");
    hud.textContent =
      `APNG 完成：${result.frames} 帧 · ` +
      `${(blob.size / 1024 / 1024).toFixed(1)} MB · ${ALPHA_W}×${ALPHA_H} 带 alpha`;
  } catch (err) {
    hud.textContent = `APNG 导出失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    endExport();
  }
}

/**
 * 导出透明 WebM：VP8 颜色轨 + 并行的 alpha 侧通道，仍是单个成片文件。
 *
 * 编解码器选 VP8 而不是 VP9：alpha 侧通道按规范挂在 VP8 的关键帧块上，
 * 播放器对 VP8-alpha 的支持面也更宽。
 */
export async function exportAlphaWebm(): Promise<void> {
  if (typeof VideoEncoder === "undefined") {
    hud.textContent = "当前浏览器不支持 WebCodecs 编码（需要 Chrome/Edge 94+）";
    return;
  }
  if (!beginExport(exportWebmBtn, "编码透明 WebM…")) return;
  try {
    const { canvas, host, painter, scene } = makeAlphaStage();
    const exporter = new WebmExporter({
      width: ALPHA_W,
      height: ALPHA_H,
      fps: BASE_FPS,
      videoCodec: "vp8",
      alpha: true,
    });
    const result = await render(scene, {
      fps: BASE_FPS,
      width: ALPHA_W,
      height: ALPHA_H,
      canvas,
      exporter,
      alpha: "alpha",
      painter,
      onProgress: (done) => {
        hud.textContent = `导出 WebM ${done} 帧…（合成后端 ${host.compositorId ?? "探测中"}）`;
      },
    });
    const blob = result.output?.output;
    if (!(blob instanceof Blob)) throw new Error("导出器未返回 Blob");
    saveBlob(blob, "ledger-alpha.webm");
    hud.textContent =
      `WebM 完成：${result.frames} 帧 · ` +
      `${(blob.size / 1024 / 1024).toFixed(1)} MB · VP8 + alpha 侧通道`;
  } catch (err) {
    hud.textContent = `WebM 导出失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    endExport();
  }
}
