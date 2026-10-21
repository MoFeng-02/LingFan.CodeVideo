/**
 * 透明产物：把同一份推演封成带 alpha 的成片或动图。
 *
 * 与 mp4 那条路的差别只有三处，其余（剧本、层、采样、合成）完全共用：
 * - 声明 `alpha: "alpha"`：引擎据此让合成器从全透明起手，未被画到的像素留在 0；
 * - 帧来源换成 `createReadbackHost`：透明编码要逐像素 alpha，拿到的是位图而不是句柄；
 * - 导出器换成保 alpha 的封装（`ApngExporter` / 带 alpha 的 `WebmExporter`）。
 *
 * 合成器在这里只能用 CPU 档：位图回读要 2D 上下文，GPU 档交的是 WebGL 画布。
 * 这也是透明路与 mp4 路唯一不能共用合成器的地方——同一批层、同一个 z 序，只是谁叠。
 */
import { render } from "@lingfan-video/core";
import {
  ApngExporter,
  WebmExporter,
  createReadbackHost,
} from "@lingfan-video/infra";

import { beginExport, endExport, saveBlob } from "./export-ui";
import { makeStageHost } from "./host";
import { buildAlphaDemo } from "./ledger/demo";
import {
  ALPHA_H,
  ALPHA_W,
  BASE_FPS,
  exportApngBtn,
  exportWebmBtn,
  hud,
} from "./session";

/**
 * 造一套透明出片用的装配：独立画布 + CPU 合成 + 位图回读。
 *
 * 画布每次新造：上一轮的残留会让「直接出片」与「先预览再出片」得到不同像素。
 * 演示片段的每一镜仍用原来那两层 id 声明层，所以宿主拿到的面与整片完全一致。
 *
 * @returns 合成宿主、包成位图的帧来源，以及整条演示片段
 */
function makeAlphaStage() {
  const canvas = document.createElement("canvas");
  canvas.width = ALPHA_W;
  canvas.height = ALPHA_H;
  // 关掉二维层的遮罩：成片靠它压暗三维场让读数读得清，但透明产物是素材，
  // 铺满整幅的暗底会把 alpha 通道填死——导出物便再也透不出后面的画面。
  const stage = makeStageHost(canvas, false, ALPHA_W, ALPHA_H, {
    scrims: false,
  });
  return {
    canvas,
    host: stage.host,
    painter: createReadbackHost(stage.host),
    scene: buildAlphaDemo({ field: stage.field, type: stage.type }),
  };
}

/**
 * 导出透明 APNG：逐帧保 alpha 的单文件动图，无音轨。
 *
 * 这条路的产物是素材（叠进别的片子或设计稿），不是带音轨的成片；
 * 演示片段里没有声音，因此也不需要混音时钟。
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
