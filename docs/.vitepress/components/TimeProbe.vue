<script setup lang="ts">
/**
 * TimeProbe：不整片出片就验证——compute 取样的活演示。
 *
 * 曲线不是引擎画出来的：先 computeRange 一次取回全部网格点状态，再把状态表
 * 里的 wave 值连成线——画面是状态的函数。滑杆每动一格，computeAt 取回该
 * 网格点的完整状态表（FrameState 按 key 聚合），下方表格原样展示。
 */
import { computed, onMounted, ref } from "vue";
import { compute } from "@lingfan-video/core";
import { LENS_MS, lensScene } from "./lens-scene";

const probe = ref<HTMLCanvasElement | null>(null);
const wave = ref<HTMLCanvasElement | null>(null);
const slider = ref(0);
const rows = ref<Array<[string, string]>>([]);
const stateErr = ref("");

/** 60fps 采样网格在 800ms 内的落点（47 个点） */
const gridTimes = computed(() => {
  const list: number[] = [];
  for (let f = 1; (f * 1000) / 60 < LENS_MS; f++) list.push(Math.round(((f * 1000) / 60) * 10) / 10);
  return list;
});

/** 状态表按单元 key 聚合（值是帧函数返回的对象）；取第一个带 wave 键的对象值 */
function waveOf(state: Record<string, unknown>): number {
  for (const v of Object.values(state)) {
    if (v !== null && typeof v === "object" && typeof (v as Record<string, unknown>).wave === "number") {
      return (v as Record<string, unknown>).wave as number;
    }
  }
  return 0;
}

/** 状态值展示：对象展开成 JSON，其余走 String() */
function show(v: unknown): string {
  return v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** 毫秒 → 画布横向像素（两侧留 8px 边距） */
function xPos(t: number, width: number): number {
  return 8 + (t / LENS_MS) * (width - 16);
}

/** 曲线 + 选中点圆点：曲线数据来自 computeRange 状态表，圆点取 computeAt 的 wave 值 */
function drawWave(states: Array<Record<string, unknown>>, t: number, waveAtT: number): void {
  const g = wave.value?.getContext("2d");
  if (!g || !wave.value) return;
  g.clearRect(0, 0, wave.value.width, wave.value.height);
  g.strokeStyle = "rgba(77, 107, 254, 0.35)";
  g.lineWidth = 2;
  g.beginPath();
  states.forEach((s, i) => {
    const v = waveOf(s);
    const x = xPos(((i + 1) * 1000) / 60, wave.value!.width);
    const y = wave.value!.height / 2 - v * (wave.value!.height / 2 - 10);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
  g.stroke();
  g.fillStyle = "#4d6bfe";
  g.beginPath();
  g.arc(xPos(t, wave.value.width), wave.value.height / 2 - waveAtT * (wave.value.height / 2 - 10), 4, 0, Math.PI * 2);
  g.fill();
}

/** 时间轴游标：选中网格点画一道竖线 */
function drawProbe(t: number): void {
  const g = probe.value?.getContext("2d");
  if (!g || !probe.value) return;
  g.clearRect(0, 0, probe.value.width, probe.value.height);
  g.fillStyle = "#4d6bfe";
  g.fillRect(xPos(t, probe.value.width) - 1, 0, 2, probe.value.height);
}

let curveStates: Array<Record<string, unknown>> = [];

/** 滑杆驱动的一次取样：computeRange 只在首次调用，之后复用；computeAt 每次现取 */
async function refresh(): Promise<void> {
  const t = gridTimes.value[slider.value] ?? 0;
  if (curveStates.length === 0) {
    curveStates = await compute.computeRange(lensScene, 0, LENS_MS);
  }
  const at = await compute.computeAt(lensScene, t);
  if (!at) {
    rows.value = [];
    stateErr.value = `${t}ms 越过时间线尾 → undefined（computeAt 对越界时刻不插值、不猜测）`;
    return;
  }
  stateErr.value = "";
  rows.value = Object.entries(at).map(([k, v]) => [k, show(v)]);
  const w = waveOf(at);
  drawWave(curveStates, t, w);
  drawProbe(t);
}

onMounted(() => void refresh());
</script>

<template>
  <div class="cv-demo">
    <canvas ref="wave" width="1152" height="220"></canvas>
    <canvas ref="probe" width="1152" height="32"></canvas>
    <div class="cv-demo-row">
      <input v-model.number="slider" type="range" min="0" :max="gridTimes.length - 1" step="1" @input="refresh" />
      <span class="cv-demo-note">{{ (gridTimes[slider] ?? 0).toFixed(1) }}ms</span>
    </div>
    <p v-if="stateErr" class="cv-demo-note">{{ stateErr }}</p>
    <table v-else class="cv-table">
      <tbody>
        <tr v-for="[k, v] in rows" :key="k">
          <td>{{ k }}</td>
          <td>{{ v }}</td>
        </tr>
      </tbody>
    </table>
    <p class="cv-demo-note">
      曲线是 computeRange 取回的 47 个网格点状态连成的线；表格是 computeAt 取回的选中点状态表（FrameState 按 key 聚合）。
      画面是状态的函数——验证只需按需开窗取样，不必出片。
    </p>
  </div>
</template>

<style scoped>
canvas:first-of-type {
  border-radius: 8px 8px 0 0;
}
canvas:last-of-type {
  border-radius: 0 0 8px 8px;
}
.cv-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.cv-table td {
  padding: 4px 12px;
  border-top: 1px solid var(--vp-c-divider);
}
.cv-table td:first-child {
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
}
</style>
