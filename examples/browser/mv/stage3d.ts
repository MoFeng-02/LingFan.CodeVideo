/**
 * 三维层：整支片子主要画面都在这里，跑在一块 WebGL 画布上。
 *
 * 内容是程序化生成的（点云、体块、网络、环），没有外部模型与贴图：
 * 位置全部由 `hash32` 生成，时间全部由歌的小节线驱动——同一毫秒永远同一帧。
 *
 * 它只交一块画布；怎么和文字层叠起来由合成器决定（CPU `drawImage` 或 GPU 四边形）。
 */
import {
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Camera,
  CanvasTexture,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
} from "three";
import { createThreeLayer } from "@lingfan-video/infra/frames/adapters/three";
import type { LayerSurface } from "@lingfan-video/infra";
import { hash32 } from "./math";
import { ACTS, actFrom, actOf, BAR_MS } from "./timeline";

const ICE = 0x9db8ff;
const BRAND = 0x4d6bfe;

function rnd(i: number): number {
  // `hash32` 已经返回 [0,1)，不要再除：早前写成 "%100000/100000"，
  // 结果全部落在 0 附近，点云塌成一个点（整幅画面空掉）。
  return hash32(i * 2654435761 + 12345);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** 点云鲸：身体是两头收的椭球，加尾叶与背鳍 */
function whaleCloud(count: number, seed: number): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const s = seed + i;
    const kind = rnd(s * 7 + 1);
    let x: number;
    let y: number;
    let z: number;
    if (kind < 0.74) {
      const u = rnd(s * 11 + 3) * Math.PI * 2;
      const along = rnd(s * 13 + 5) * 2 - 1;
      const taper = Math.cos((along * Math.PI) / 2) ** 0.7;
      const r = 0.42 * taper + 0.04;
      x = along * 2.6;
      y = Math.cos(u) * r * 1.05 + 0.1;
      z = Math.sin(u) * r * 0.95;
    } else if (kind < 0.92) {
      const spread = rnd(s * 17 + 7) * 2 - 1;
      const lift = rnd(s * 19 + 9);
      x = -2.5 - lift * 0.55;
      y = spread * 0.55 + lift * 0.12;
      z = (rnd(s * 23 + 11) * 2 - 1) * 0.06;
    } else {
      const t = rnd(s * 29 + 13);
      x = 0.15 + t * 0.5;
      y = 0.42 + t * 0.34;
      z = (rnd(s * 31 + 17) * 2 - 1) * 0.05;
    }
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
}

/** 球面点云：均匀撒点（取 v 的余弦，避免两极堆积） */
function sphereCloud(
  count: number,
  radius: number,
  seed: number,
): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const u = rnd(seed + i * 3 + 1) * Math.PI * 2;
    const v = Math.acos(rnd(seed + i * 5 + 2) * 2 - 1);
    out[i * 3] = Math.sin(v) * Math.cos(u) * radius;
    out[i * 3 + 1] = Math.cos(v) * radius;
    out[i * 3 + 2] = Math.sin(v) * Math.sin(u) * radius;
  }
  return out;
}

function dotMaterial(
  size: number,
  opacity: number,
  color = ICE,
): PointsMaterial {
  return new PointsMaterial({
    // 关掉按距离缩放：这一个 size 就是**输出像素**，点云才看得见
    sizeAttenuation: false,
    size,
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

interface Groups {
  wall: Group;
  burst: Group;
  globe: Group;
  voxel: Group;
  whale: Group;
  pod: Group;
  stars: Group;
}

/** 哪些段用哪组内容；其余组隐藏 */
const VISIBILITY: Record<string, readonly (keyof Groups)[]> = {
  before: ["wall", "stars"],
  open: ["wall", "burst", "stars"],
  spread: ["globe", "stars"],
  shift: ["globe", "voxel", "stars"],
  vibe: ["voxel", "stars"],
  me: ["whale", "stars"],
  changed: ["globe", "stars"],
  ai: ["voxel", "stars"],
  made: ["voxel", "whale", "stars"],
  together: ["pod", "stars"],
  still: ["whale", "stars"],
  withyou: ["pod", "globe", "stars"],
  now: ["globe", "pod", "stars"],
  hand: ["whale", "stars"],
};

export function createStage3d(width: number, height: number): LayerSurface {
  const groups: Groups = {
    wall: new Group(),
    burst: new Group(),
    globe: new Group(),
    voxel: new Group(),
    whale: new Group(),
    pod: new Group(),
    stars: new Group(),
  };
  let camera: PerspectiveCamera | null = null;
  const slabs: Mesh[] = [];
  const shards: Mesh[] = [];
  const nodes: Mesh[] = [];
  const podWhales: Points[] = [];
  let ringA: Mesh | null = null;
  let ringB: Mesh | null = null;
  let voxels: InstancedMesh | null = null;
  let whaleBody: Points | null = null;

  const layer = createThreeLayer({
    spec: { id: "stage3d", z: 0, blend: "normal" },
    width,
    height,
    createCamera: ({ width: w, height: h }) => {
      const cam = new PerspectiveCamera(46, w / h, 0.1, 260);
      cam.position.set(0, 0.6, 16);
      cam.lookAt(0, 0, 0);
      return cam;
    },
    build: ({ scene, camera: cam }) => {
      camera = cam as PerspectiveCamera;
      // 背景不用纯黑：一块很远的渐变天幕，越往下越深，画面才有"空间"而不是"空"
      const sky = document.createElement("canvas");
      sky.width = 4;
      sky.height = 256;
      const skyCtx = sky.getContext("2d");
      if (skyCtx) {
        const grad = skyCtx.createLinearGradient(0, 0, 0, 256);
        grad.addColorStop(0, "#04070d");
        grad.addColorStop(0.52, "#071528");
        grad.addColorStop(0.78, "#0b2340");
        grad.addColorStop(1, "#02040a");
        skyCtx.fillStyle = grad;
        skyCtx.fillRect(0, 0, 4, 256);
      }
      const skyTexture = new CanvasTexture(sky);
      skyTexture.colorSpace = SRGBColorSpace;
      const backdrop = new Mesh(
        new PlaneGeometry(220, 130),
        new MeshBasicMaterial({ map: skyTexture, depthWrite: false }),
      );
      backdrop.position.set(0, 0, -46);
      backdrop.renderOrder = -500;
      scene.add(backdrop);
      scene.background = null;
      for (const g of Object.values(groups)) {
        g.visible = false;
        scene.add(g);
      }
      scene.add(new AmbientLight(0x35507f, 2.0));
      const key = new DirectionalLight(0xc3d6ff, 2.4);
      key.position.set(-6, 9, 7);
      scene.add(key);
      const fill = new DirectionalLight(BRAND, 1.0);
      fill.position.set(8, -5, -6);
      scene.add(fill);

      // ── 很久以前：一面关着的墙（板子有缝，缝里没有光）
      const slabMat = new MeshStandardMaterial({
        color: 0x0b1728,
        metalness: 0.4,
        roughness: 0.6,
      });
      const slabGeo = new BoxGeometry(2.5, 4.4, 0.5);
      for (let row = 0; row < 5; row += 1) {
        for (let col = 0; col < 9; col += 1) {
          const m = new Mesh(slabGeo, slabMat);
          m.position.set(
            (col - 4) * 2.62,
            (row - 2) * 4.62,
            -3.2 - rnd(row * 31 + col) * 1.2,
          );
          m.rotation.z = (rnd(row * 17 + col * 5) - 0.5) * 0.05;
          groups.wall.add(m);
          slabs.push(m);
        }
      }

      // ── 开源那一下：两圈冲击 + 飞的碎片
      const ringMatA = new MeshStandardMaterial({
        color: 0xbfd4ff,
        emissive: BRAND,
        emissiveIntensity: 2.2,
        transparent: true,
      });
      ringA = new Mesh(new TorusGeometry(1, 0.03, 8, 96), ringMatA);
      ringA.rotation.x = Math.PI / 2.1;
      groups.burst.add(ringA);
      const ringMatB = new MeshStandardMaterial({
        color: 0xffffff,
        emissive: ICE,
        emissiveIntensity: 2.6,
        transparent: true,
      });
      ringB = new Mesh(new TorusGeometry(1, 0.014, 8, 96), ringMatB);
      ringB.rotation.x = Math.PI / 2.1;
      groups.burst.add(ringB);
      const shardGeo = new BoxGeometry(0.5, 0.9, 0.12);
      const shardMat = new MeshStandardMaterial({
        color: 0x162a48,
        metalness: 0.4,
        roughness: 0.5,
        transparent: true,
      });
      for (let i = 0; i < 120; i += 1) {
        const m = new Mesh(shardGeo, shardMat);
        groups.burst.add(m);
        shards.push(m);
      }

      // ── 撒出去 / 格局：点云球 + 逐拍点亮的节点
      groups.globe.add(
        new Points(
          new BufferGeometry().setAttribute(
            "position",
            new Float32BufferAttribute(sphereCloud(1500, 3.2, 11), 3),
          ),
          dotMaterial(2.4, 0.95),
        ),
      );
      groups.globe.add(
        new Mesh(
          new SphereGeometry(3.2, 24, 16),
          new MeshStandardMaterial({
            color: 0x0d2747,
            metalness: 0.25,
            roughness: 0.8,
            transparent: true,
            opacity: 0.16,
          }),
        ),
      );
      const nodeGeo = new SphereGeometry(0.06, 8, 6);
      const nodeMat = new MeshStandardMaterial({
        color: 0xdce8ff,
        emissive: BRAND,
        emissiveIntensity: 1.4,
      });
      const anchors = sphereCloud(120, 3.24, 777);
      for (let i = 0; i < 120; i += 1) {
        const n = new Mesh(nodeGeo, nodeMat);
        n.position.set(
          anchors[i * 3]!,
          anchors[i * 3 + 1]!,
          anchors[i * 3 + 2]!,
        );
        groups.globe.add(n);
        nodes.push(n);
      }

      // ── 一句话 / 从零：从网格里长出来的体块
      const voxGeo = new BoxGeometry(0.42, 0.42, 0.42);
      const voxMat = new MeshStandardMaterial({
        color: 0x10243f,
        metalness: 0.35,
        roughness: 0.5,
        emissive: 0x1b3a6b,
        emissiveIntensity: 0.7,
      });
      voxels = new InstancedMesh(voxGeo, voxMat, 240);
      groups.voxel.add(voxels);

      // ── 现在的我 / 交给所有人：点云鲸 + 一群鲸
      whaleBody = new Points(
        new BufferGeometry().setAttribute(
          "position",
          new Float32BufferAttribute(whaleCloud(4200, 0), 3),
        ),
        dotMaterial(2.2, 0.95, 0xcfe0ff),
      );
      groups.whale.add(whaleBody);
      for (let i = 0; i < 7; i += 1) {
        const p = new Points(
          new BufferGeometry().setAttribute(
            "position",
            new Float32BufferAttribute(whaleCloud(650, 5000 + i * 900), 3),
          ),
          dotMaterial(3.0, 0.6, ICE),
        );
        groups.pod.add(p);
        podWhales.push(p);
      }

      // ── 星空：包住所有段的远景
      groups.stars.add(
        new Points(
          new BufferGeometry().setAttribute(
            "position",
            new Float32BufferAttribute(sphereCloud(1600, 62, 31), 3),
          ),
          dotMaterial(2.2, 1.0, 0xdfe8ff),
        ),
      );
    },
    update: (t) => {
      const act = actOf(t);
      const local = clamp01((t - act.from) / (act.to - act.from));
      const barLocal = (t - act.from) / BAR_MS;
      const visible = VISIBILITY[act.id] ?? ["stars"];
      for (const [key, group] of Object.entries(groups)) {
        group.visible = visible.includes(key as keyof Groups);
      }

      const cam = camera;
      if (cam) {
        // 每一段一套机位：推/绕/俯，全部用缓动，不用随机
        if (act.id === "before") {
          cam.position.set(0, 0.4, 15.4 - local * 7.4);
          cam.lookAt(0, 0.3, -3.2);
        } else if (act.id === "open") {
          const punch = smoothstep(0, 0.35, local);
          cam.position.set(0, 0.5 + local * 1.8, 11.2 - punch * 3.4);
          cam.lookAt(0, 0.4, -2);
        } else if (
          act.id === "spread" ||
          act.id === "shift" ||
          act.id === "changed" ||
          act.id === "now"
        ) {
          const a = (t - actFrom("spread").from) / 7000 + local * 0.9;
          cam.position.set(
            Math.sin(a) * 4.6,
            1.4 + Math.sin(a * 0.7) * 0.6,
            9.6,
          );
          cam.lookAt(0, 0, 0);
        } else if (act.id === "vibe" || act.id === "ai" || act.id === "made") {
          cam.position.set(
            2.6,
            2.4 - local * 0.5,
            9.0 + (act.id === "ai" ? 1.4 : 0),
          );
          cam.lookAt(0, -0.7, 0);
        } else if (act.id === "me" || act.id === "still" || act.id === "hand") {
          cam.position.set(Math.sin(t / 11000) * 1.3, 0.7, 9.4 - local * 1.6);
          cam.lookAt(0, 0.15, 0);
        } else if (act.id === "together" || act.id === "withyou") {
          cam.position.set(0, 0.9, 13.5 - local * 4.5);
          cam.lookAt(0, 0, -6);
        } else {
          cam.position.set(0, 0.6, 16);
          cam.lookAt(0, 0, 0);
        }
      }

      // 墙：一直关着；「开源」那一下被从里面顶开
      const openFrom = actFrom("open").from;
      const openP = clamp01((t - openFrom) / 1100);
      for (const [i, slab] of slabs.entries()) {
        const push = openP * (0.5 + rnd(i * 13) * 1.2);
        slab.position.z = -3.2 - rnd(i * 17) * 1.2 + push * 1.6;
        slab.rotation.y = openP * (rnd(i * 19) - 0.5) * 0.7;
        slab.rotation.z =
          (rnd(i * 23) - 0.5) * 0.05 + openP * (rnd(i * 29) - 0.5) * 0.3;
      }

      // 冲击环：随时间扩张，透明度衰减
      for (const [i, ring] of [ringA, ringB].entries()) {
        if (!ring) continue;
        const p = clamp01((t - openFrom - i * 130) / 1500);
        ring.scale.setScalar(0.6 + p * 9.5);
        const mat = ring.material as MeshStandardMaterial;
        mat.opacity = Math.max(0, 1 - p) * 0.9;
      }
      // 碎片：从中心飞出、边飞边转
      for (const [i, shard] of shards.entries()) {
        const born = openFrom + (i % 40) * 18;
        const p = clamp01((t - born) / 2400);
        const dir = new THREE_VEC3(
          rnd(i * 23) - 0.5,
          rnd(i * 29) - 0.5,
          rnd(i * 31) * 0.9 + 0.1,
        );
        dir.normalize();
        shard.position.set(
          dir.x * (0.4 + p * (2.6 + rnd(i * 37) * 3.6)),
          dir.y * (0.4 + p * 2.4) + 0.5,
          dir.z * (0.5 + p * (2.2 + rnd(i * 41) * 2.4)),
        );
        shard.rotation.set(
          p * 3 * rnd(i * 43),
          p * 2 * rnd(i * 47),
          p * 4 * rnd(i * 53),
        );
        const mat = shard.material as MeshStandardMaterial;
        mat.opacity = Math.max(0, 1 - p) * 0.85;
      }

      // 球：自转；节点按拍逐个点亮（越往后越密）
      groups.globe.rotation.y = t / 11000;
      const beatLocal = barLocal * 4;
      for (const [i, node] of nodes.entries()) {
        const on = beatLocal > i * 0.5;
        const mat = node.material as MeshStandardMaterial;
        mat.emissiveIntensity = on
          ? 1.1 + 1.8 * Math.max(0, Math.sin((beatLocal - i * 0.5) * Math.PI))
          : 0.1;
        node.scale.setScalar(on ? 1 + 0.7 * rnd(i * 59) : 0.55);
      }

      // 体块：从下往上长（用实例矩阵，一次写入）
      if (voxels) {
        const grow = clamp01((t - actFrom("vibe").from) / 3400);
        const m4 = new Matrix4();
        let k = 0;
        for (let gx = 0; gx < 9; gx += 1) {
          for (let gz = 0; gz < 9; gz += 1) {
            const height = 1 + Math.floor(rnd(gx * 41 + gz * 7) * 6);
            for (let gy = 0; gy < height; gy += 1) {
              const appear = clamp01((grow * 6.5 - gy) / 1.2);
              if (appear <= 0) continue;
              m4.makeTranslation(
                (gx - 4) * 0.62,
                -2.6 + gy * 0.44 * appear,
                (gz - 4) * 0.62,
              );
              voxels.setMatrixAt(k, m4);
              k += 1;
              if (k >= 240) break;
            }
            if (k >= 240) break;
          }
          if (k >= 240) break;
        }
        for (let i = k; i < 240; i += 1)
          (m4.makeScale(0, 0, 0), voxels.setMatrixAt(i, m4));
        voxels.instanceMatrix.needsUpdate = true;
        (voxels.material as MeshStandardMaterial).emissiveIntensity =
          0.5 + 0.5 * grow;
      }

      // 鲸：缓慢摆尾 + 呼吸
      if (whaleBody) {
        whaleBody.rotation.z = Math.sin(t / 2600) * 0.06;
        whaleBody.rotation.y = -0.3 + Math.sin(t / 7000) * 0.2;
        whaleBody.position.set(
          Math.sin(t / 6000) * 0.4,
          -0.1 + Math.sin(t / 4200) * 0.12,
          0,
        );
        const mat = whaleBody.material as PointsMaterial;
        mat.opacity = 0.75 + 0.18 * Math.sin(t / 2300);
        const near = act.id === "me" ? 1 : 0.82;
        whaleBody.scale.setScalar(near);
      }
      // 一群鲸：按索引错开深度与高度
      for (const [i, child] of podWhales.entries()) {
        child.position.set(
          ((i % 3) - 1) * 3.6 + Math.sin(t / 5200 + i) * 0.7,
          i * 0.3 - 0.8,
          -6 - i * 2.6 - local * 11,
        );
        child.rotation.y = Math.PI * 0.5 + Math.sin(t / 6000 + i) * 0.22;
        child.scale.setScalar(1 + i * 0.1);
      }

      groups.stars.rotation.y = t / 48000;
      // 片尾：灯全暗，只剩星
      if (t > 134298) {
        for (const key of [
          "wall",
          "burst",
          "globe",
          "voxel",
          "whale",
          "pod",
        ] as const) {
          groups[key].visible = false;
        }
      }
    },
    dispose: () => {
      for (const g of Object.values(groups)) g.clear();
    },
  });

  return layer.surface;
}

// three 的 Vector3 只在这里用到一次，单独起名避免和本地工具函数混淆
import { Vector3 as THREE_VEC3 } from "three";
void ACTS;
void Group;
void Scene;
void Camera;
