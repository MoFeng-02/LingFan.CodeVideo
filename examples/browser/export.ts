/**
 * 导出：与预览同一份剧本、同一批层、同一个合成宿主，差异只在消费端——
 * 预览贴回舞台实时放；导出把合成画布直接交给编码器，音频离线混。
 */
import { render } from "@lingfan-video/core";
import {
  OfflineAudioMixer,
  WebCodecsExporter,
  createCanvas2dCompositor,
} from "@lingfan-video/infra";
import { createThreeCompositor } from "@lingfan-video/infra/frames/adapters/three-compositor";

import { makeSynthDecoder } from "./audio-assets";
import { beginExport, endExport, saveBlob } from "./export-ui";
import { makeStageHost } from "./host";
import { BASE_FPS, HEIGHT, WIDTH, exportBtn, hud } from "./session";

/** 导出 mp4：H.264 视频 + AAC 音轨。 */
export async function exportMp4(): Promise<void> {
  if (
    typeof VideoEncoder === "undefined" ||
    typeof AudioEncoder === "undefined"
  ) {
    hud.textContent = "当前浏览器不支持 WebCodecs 编码（需要 Chrome/Edge 94+）";
    return;
  }
  if (!beginExport(exportBtn, "编码中…")) return;
  try {
    // 导出用一块独立画布：预览画布上留着上一次播放的最后一帧与 2D 状态，
    // 复用会让「先预览再导出」与「直接导出」得到不同像素。
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = WIDTH;
    exportCanvas.height = HEIGHT;
    const { host, program } = makeStageHost(exportCanvas, WIDTH, HEIGHT, {
      // 导出要吞吐：先给 GPU 档让合成结果直接进编码器，拿不到再退 CPU 档
      compositors: [
        () => createThreeCompositor(),
        () => createCanvas2dCompositor(),
      ],
    });
    const exporter = new WebCodecsExporter({
      width: WIDTH,
      height: HEIGHT,
      fps: BASE_FPS,
      // 画面以大面积暗部为主，7Mbps 足够；再高只是把文件撑大。
      bitrate: 7_000_000,
    });
    const audio = new OfflineAudioMixer(makeSynthDecoder(48_000), {
      sampleRate: 48_000,
      channels: 2,
    });
    const result = await render(program.picture, {
      fps: BASE_FPS,
      width: WIDTH,
      height: HEIGHT,
      canvas: exportCanvas,
      exporter,
      audio,
      headless: false,
      painter: host,
      onProgress: (done) => {
        hud.textContent = `导出 ${done} 帧…（合成后端 ${host.compositorId ?? "探测中"}）`;
      },
    });
    const output = result.output;
    if (!output) throw new Error("导出未返回结果（exporter 未 finalize）");
    const blob = output.output;
    if (!(blob instanceof Blob)) throw new Error("导出器未返回 Blob");
    saveBlob(blob, "deepseek-version-log.mp4");
    hud.textContent =
      `导出完成：${result.frames} 帧 · ` +
      `${(blob.size / 1024 / 1024).toFixed(1)} MB · 已开始下载`;
  } catch (err) {
    hud.textContent = `导出失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    endExport();
  }
}
