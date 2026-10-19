<script setup lang="ts">
/**
 * 首页 hero 组件：把 heroScene 三幕链在浏览器里推演给观众看。
 *
 * 预览装配走最小依赖姿势：帧函数直接画在可见舞台画布上，painter 注入 1×1
 * 廉价位图满足引擎的帧来源要求（不做整幅 getImageData 回读），节流交给
 * PacedPreviewExporter 的墙钟。总时长 1700ms 是链编译的产物——进度条分段
 * 直接读 HERO_TIMELINE 的编译落位，不在组件里另算一份时间表。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { render } from "@lingfan-video/core";
import { PacedPreviewExporter } from "@lingfan-video/infra";
import { HERO_FPS, HERO_HEIGHT, HERO_TIMELINE, HERO_TOTAL, HERO_WIDTH, heroScene } from "./hero-scene";

const stage = ref<HTMLCanvasElement | null>(null);
const running = ref(false);
const paused = ref(false);
const doneMs = ref(0);
const failed = ref("");

/** 三段进度条：段宽 = 各幕编译时长占比，填充 = 全局进度在段内的位置 */
const segs = computed(() =>
  HERO_TIMELINE.map((seg) => ({
    weight: seg.duration,
    fill: `${Math.max(0, Math.min(1, (doneMs.value - seg.start) / seg.duration)) * 100}%`,
  })),
);

const note = computed(() => {
  if (failed.value) return failed.value;
  const act = [...HERO_TIMELINE].reverse().find((seg) => doneMs.value >= seg.start);
  return running.value
    ? paused.value
      ? "已暂停"
      : `推演中 · ${act ? act.id : "登记"} · ${Math.round(doneMs.value)}ms / ${HERO_TOTAL}ms`
    : doneMs.value >= HERO_TOTAL
      ? "推演完毕：同一份剧本每次逐帧相同"
      : "同一份剧本，每次推演逐帧相同";
});

async function run(): Promise<void> {
  if (running.value || !stage.value) return;
  running.value = true;
  paused.value = false;
  failed.value = "";
  doneMs.value = 0;
  const sink = new PacedPreviewExporter({ clock: () => performance.now(), paused: () => paused.value });
  try {
    await render(heroScene, {
      fps: HERO_FPS,
      width: HERO_WIDTH,
      height: HERO_HEIGHT,
      canvas: stage.value,
      exporter: sink,
      painter: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
      frames: "required",
      headless: false,
      onProgress: (done, total) => {
        if (!disposed) doneMs.value = (done / total) * HERO_TOTAL;
      },
    });
    if (!disposed) doneMs.value = HERO_TOTAL;
  } catch (error) {
    if (!disposed) failed.value = `推演失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    running.value = false;
  }
}

function toggle(): void {
  if (!running.value) void run();
  else paused.value = !paused.value;
}

let disposed = false;
onMounted(() => void run());
onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <div class="cv-demo">
    <canvas ref="stage" :width="HERO_WIDTH" :height="HERO_HEIGHT"></canvas>
    <div class="cv-chain">
      <div v-for="(seg, i) in segs" :key="i" class="cv-chain-seg" :style="{ flexGrow: seg.weight }">
        <div class="cv-chain-fill" :style="{ width: seg.fill }"></div>
      </div>
    </div>
    <div class="cv-demo-row">
      <button type="button" @click="toggle">{{ running ? (paused ? "继续" : "暂停") : doneMs >= HERO_TOTAL ? "重播" : "推演" }}</button>
      <span class="cv-demo-note">{{ note }}</span>
    </div>
    <p class="cv-demo-note">
      三幕由链拼接、幕间 transitionTo 重叠 150ms；总时长 1700ms 是链编译的产物——进度条按编译落位分段，组件里没有第二份时间表。
    </p>
  </div>
</template>
