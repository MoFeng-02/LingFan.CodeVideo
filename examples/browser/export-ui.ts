/**
 * 出片页面的公共动作：占位、收尾、交付下载。
 *
 * 三条出片路径（mp4 / 透明 APNG / 透明 WebM）共用同一份互斥：推演只有一条时间线，
 * 两条同时跑会互相抢同一块画布与同一份编码队列。差别只在各自拿什么导出器、
 * 跑哪一份程序，所以这里只管「一次只能跑一个」与「产物怎么落地」。
 */
import {
  exportApngBtn,
  exportBtn,
  exportWebmBtn,
  hud,
  playBtn,
  session,
} from "./session";

/** 三个导出按钮：占位与恢复要一起动，漏一个就会出现「导出中还能再点」 */
const buttons = [exportBtn, exportApngBtn, exportWebmBtn];

/**
 * 占位：标记推演占用中，禁用所有入口，并把调用方按钮的文案改成进行时。
 *
 * @param button 触发本次导出的按钮（只有它的文案改成进行时）
 * @param label HUD 首行文案
 * @returns 已经有一次推演在跑时返回 false，调用方直接放弃
 */
export function beginExport(button: HTMLButtonElement, label: string): boolean {
  if (session.busy) return false;
  session.busy = true;
  playBtn.disabled = true;
  for (const target of buttons) target.disabled = true;
  button.textContent = "导出中…";
  hud.textContent = label;
  return true;
}

/** 收尾：无论如何都恢复三个按钮与播放键的原状（导出失败也要能再点） */
export function endExport(): void {
  session.busy = false;
  playBtn.disabled = false;
  exportBtn.disabled = false;
  exportApngBtn.disabled = false;
  exportWebmBtn.disabled = false;
  exportBtn.textContent = "导出 MP4";
  exportApngBtn.textContent = "导出透明 APNG";
  exportWebmBtn.textContent = "导出透明 WebM";
}

/**
 * 把产物交给浏览器下载。
 *
 * 对象 URL 用完即撤：一篇长篇的 APNG 可能上百 MB，留着不放会一直占住内存。
 *
 * @param blob 产物
 * @param filename 下载文件名
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
