/**
 * 前半程图形（boot → mesh）：从空白地平线到稀疏曲面的十镜。
 *
 * 两条硬约束贯穿全部图形：端点落在 |x|≤3.6、|y|≤2.2、z∈[-6,6] 内；
 * 同一镜内不写两条重合的线——加性混合下重叠处会烧成白块，所以节点用
 * 斜十字避开路径、扫描线与边框错位。出现与生长只由 local 决定。
 */
import {
  BRAND,
  DIM,
  ICE,
  INK,
  WARM,
  glyph,
  hash01,
  smooth,
  type P,
} from "./lines";

/** 空白里先有一条地平线，再向下长出等距刻度；刻度数随 local 增加 */
export const boot = glyph(INK, (w, _t, l) => {
  const grow = smooth(l / 0.45);
  if (grow > 0) w.line([-3.6 * grow, 0, 0], [3.6 * grow, 0, 0]);
  const ticks = Math.floor(24 * smooth((l - 0.22) / 0.6));
  for (let i = 0; i < ticks; i += 1) {
    const x = -3.5 + i * 0.3;
    w.line([x, 0, 0], [x, i % 4 === 0 ? -0.6 : -0.3, 0]);
  }
});

/** 整片点阵是暗的，只有一条走位路径被点亮；local 推进点亮更多节点 */
export const lattice = glyph(ICE, (w, _t, l) => {
  const xs = [-3, -1.5, 0, 1.5, 3];
  const ys = [-1.6, -0.8, 0, 0.8, 1.6];
  const zs = [-4.5, -2.5, -0.5];
  const cell = (x: number, y: number, z: number): number =>
    (y * zs.length + z) * xs.length + x;
  // 走位路径每格只进一次，所以不会把同一条线段写第二遍
  const visited = new Set<number>();
  let nx = 2;
  let ny = 2;
  let nz = 1;
  visited.add(cell(nx, ny, nz));
  const cells = [cell(nx, ny, nz)];
  const route: P[] = [[xs[nx]!, ys[ny]!, zs[nz]!]];
  const dirs: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  for (let k = 0; k < 16; k += 1) {
    const start = Math.floor(hash01(k * 31 + 7) * 6);
    let moved = false;
    for (let j = 0; j < 6 && !moved; j += 1) {
      const [dx, dy, dz] = dirs[(start + j) % 6]!;
      const cx = nx + dx;
      const cy = ny + dy;
      const cz = nz + dz;
      if (cx < 0 || cx > 4 || cy < 0 || cy > 4 || cz < 0 || cz > 2) continue;
      const id = cell(cx, cy, cz);
      if (visited.has(id)) continue;
      visited.add(id);
      nx = cx;
      ny = cy;
      nz = cz;
      cells.push(id);
      route.push([xs[nx]!, ys[ny]!, zs[nz]!]);
      moved = true;
    }
    if (!moved) break;
  }
  const lit = Math.min(cells.length, 4 + Math.floor(8 * smooth(l)));
  const litCells = new Set(cells.slice(0, lit));
  // 每个节点只画一次：被点亮的把斜十字画大，而不是在原位叠一条更长的线
  for (let ix = 0; ix < xs.length; ix += 1) {
    for (let iy = 0; iy < ys.length; iy += 1) {
      for (let iz = 0; iz < zs.length; iz += 1) {
        const s = litCells.has(cell(ix, iy, iz)) ? 0.16 : 0.08;
        const x = xs[ix]!;
        const y = ys[iy]!;
        const z = zs[iz]!;
        w.line([x - s, y - s, z], [x + s, y + s, z]);
        w.line([x - s, y + s, z], [x + s, y - s, z]);
      }
    }
  }
  w.path(route.slice(0, lit));
});

interface Branch {
  readonly a: P;
  readonly b: P;
  readonly start: number;
}

/**
 * 推理树在模块加载时算一次：拓扑是确定性的常量，不随帧变。
 * 四层 × 0.95，主干从 y=-1.9 抬到 y=1.9，不出上下边界。
 */
function buildTree(): Branch[] {
  const out: Branch[] = [];
  const grow = (
    x: number,
    y: number,
    z: number,
    turn: number,
    depth: number,
    seed: number,
  ): void => {
    const len = 0.95;
    const x2 = x + Math.sin(turn) * len;
    const y2 = y + Math.cos(turn) * len;
    const z2 = z + Math.cos(turn) * 0.15;
    out.push({
      a: [x, y, z],
      b: [x2, y2, z2],
      start: (depth - 1) * 0.22 + hash01(seed) * 0.1,
    });
    if (depth >= 4) return;
    const kids = 2 + (hash01(seed * 7 + 3) > 0.4 ? 1 : 0);
    const spread = 0.45 + hash01(seed * 3 + 1) * 0.3;
    for (let i = 0; i < kids; i += 1) {
      const next = (i / Math.max(1, kids - 1) - 0.5) * 2 * spread;
      grow(x2, y2, z2, next, depth + 1, seed * 5 + i + 1);
    }
  };
  grow(0, -1.9, 0, 0, 1, 1);
  return out;
}

const TREE = buildTree();

/** 推理树：每段有自己的出现门槛，local 走到哪长到哪 */
export const tree = glyph(ICE, (w, _t, l) => {
  for (const branch of TREE) {
    if (l + 0.02 >= branch.start) w.line(branch.a, branch.b);
  }
});

/** 闭合立方体先缓慢自转，然后六个面沿法线散开停住 */
export const open = glyph(ICE, (w, t, l) => {
  // 最大位移压在 1.2：再大，倾斜后的 y 面角点就顶出 |y|≤2.2
  const sep = 1.2 * smooth((l - 0.35) / 0.55);
  const ry = t * 0.00016 + l * 0.5;
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cx = Math.cos(0.32);
  const sx = Math.sin(0.32);
  const spin = (x: number, y: number, z: number): P => {
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    return [x1, y * cx - z1 * sx, y * sx + z1 * cx];
  };
  const s = 0.6;
  const face = (axis: number, sign: number): P[] => {
    const d = sign * (s + sep);
    return axis === 0
      ? [spin(d, -s, -s), spin(d, s, -s), spin(d, s, s), spin(d, -s, s)]
      : axis === 1
        ? [spin(-s, d, -s), spin(s, d, -s), spin(s, d, s), spin(-s, d, s)]
        : [spin(-s, -s, d), spin(s, -s, d), spin(s, s, d), spin(-s, s, d)];
  };
  if (sep < 0.02) {
    // 合拢时立方体每条棱只属于两个面：逐面画会把同一条棱写两遍，
    // 所以闭拢阶段改画十二条独立的棱，散开后再换成六个面的边框
    for (let axis = 0; axis < 3; axis += 1) {
      for (const i of [-1, 1]) {
        for (const j of [-1, 1]) {
          const a: P =
            axis === 0
              ? [s, i * s, j * s]
              : axis === 1
                ? [i * s, s, j * s]
                : [i * s, j * s, s];
          const b: P =
            axis === 0
              ? [-s, i * s, j * s]
              : axis === 1
                ? [i * s, -s, j * s]
                : [i * s, j * s, -s];
          w.line(spin(...a), spin(...b));
        }
      }
    }
    return;
  }
  for (let axis = 0; axis < 3; axis += 1) {
    for (const sign of [-1, 1]) {
      const corners = face(axis, sign);
      w.path([...corners, corners[0]!]);
    }
  }
});

/** 冲击：断崖折线 + 从中心扩散的水平环波 + 几条放射短线 */
export const shock = glyph(WARM, (w, _t, l) => {
  const ys = [2.0, 1.85, 1.65, 1.35, 1.25, 0.25, -0.3, -0.5, -1.0, -1.55, -2.0];
  w.path(ys.map((y, i): P => [-3.4 + i * 0.68, y, 0]));
  const r = 0.3 + 2.7 * smooth(l);
  const y = 0.35;
  for (let i = 0; i < 64; i += 1) {
    const a0 = (i / 64) * Math.PI * 2;
    const a1 = ((i + 1) / 64) * Math.PI * 2;
    w.line(
      [Math.cos(a0) * r, y, Math.sin(a0) * r],
      [Math.cos(a1) * r, y, Math.sin(a1) * r],
    );
  }
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    w.line(
      [Math.cos(a) * (r + 0.25), y, Math.sin(a) * (r + 0.25)],
      [Math.cos(a) * (r + 0.6), y, Math.sin(a) * (r + 0.6)],
    );
  }
});

/** 七层水平薄线框；每条亮线沿 +x 扫过一层，扫到框内就停，不压边框 */
export const deck = glyph(BRAND, (w, _t, l) => {
  for (let i = 0; i < 7; i += 1) {
    const y = -1.8 + i * 0.6;
    const z0 = -5.4 + i * 0.2;
    w.path([
      [-3.6, y, z0],
      [3.6, y, z0],
      [3.6, y, -1.2],
      [-3.6, y, -1.2],
      [-3.6, y, z0],
    ]);
    // 扫描线留在框内：贴着左右边框扫会与边框共线，加性混合下烧白
    const sx = -3.5 + ((l * 1.15 + i * 0.14) % 1) * 7;
    w.line([sx, y, z0], [sx, y, -1.2]);
  }
});

/** 螺旋往上长；三条更细的平行螺旋错开半径与相位，防止读成一个锥子 */
export const spiral = glyph(ICE, (w, _t, l) => {
  const g = smooth(l);
  const rings: ReadonlyArray<readonly [number, number, number]> = [
    [1.1, 0, 120],
    [1.34, 0.6, 44],
    [0.95, 1.3, 44],
    [1.22, 2.1, 44],
  ];
  for (const [r, phase, total] of rings) {
    const n = Math.max(1, Math.floor(total * g));
    for (let k = 1; k <= n; k += 1) {
      const a0 = ((k - 1) / total) * Math.PI * 10 + phase;
      const a1 = (k / total) * Math.PI * 10 + phase;
      const y0 = -1.25 + ((k - 1) / total) * 2.5;
      const y1 = -1.25 + (k / total) * 2.5;
      w.line(
        [Math.cos(a0) * r, y0, Math.sin(a0) * r],
        [Math.cos(a1) * r, y1, Math.sin(a1) * r],
      );
    }
  }
});

/** 一圈十二个节点；高亮节点把十字画长一点，两条执行链只连其中六个 */
export const tools = glyph(BRAND, (w, _t, l) => {
  // 外环比节点半径大 0.1：贴着节点画会让节点十字与弦几乎共线
  for (let i = 0; i < 48; i += 1) {
    const a0 = (i / 48) * Math.PI * 2;
    const a1 = ((i + 1) / 48) * Math.PI * 2;
    w.line(
      [Math.cos(a0) * 1.9, 0, Math.sin(a0) * 1.9],
      [Math.cos(a1) * 1.9, 0, Math.sin(a1) * 1.9],
    );
  }
  const at = (i: number): P => [
    Math.cos((i / 12) * Math.PI * 2) * 1.8,
    0,
    Math.sin((i / 12) * Math.PI * 2) * 1.8,
  ];
  const hi = Math.floor(l * 12) % 12;
  for (let i = 0; i < 12; i += 1) {
    const [x, , z] = at(i);
    const s = i === hi ? 0.24 : 0.1;
    w.line([x - s, 0, z], [x + s, 0, z]);
    w.line([x, 0, z - s], [x, 0, z + s]);
  }
  for (const chain of [
    [0, 3, 6],
    [7, 9, 11],
  ]) {
    w.path(chain.map((i) => at(i)));
  }
});

/** 稳定基准面：极密网格里留一小片线，抖动衰减到停住 */
export const steady = glyph(DIM, (w, t, l) => {
  const n = 56;
  // 只抬其中三条：整片一起动像镜头晃，不动又看不出"稳定"
  const patch = new Set([26, 27, 28]);
  const amp = 0.07 * (1 - smooth(l / 0.7));
  for (let i = 0; i < n; i += 1) {
    const x = -3.6 + (i * 7.2) / (n - 1);
    const j = patch.has(i) ? amp * Math.sin(t * 0.02 + i * 1.9) + 0 : 0;
    w.line([x, j, -3.6], [x, j, 3.6]);
  }
  for (let i = 0; i < n; i += 1) {
    const z = -3.6 + (i * 7.2) / (n - 1);
    const j = patch.has(i) ? amp * Math.sin(t * 0.02 + i * 2.3 + 1) + 0 : 0;
    w.line([-3.6, j, z], [3.6, j, z]);
  }
});

/** 稀疏注意力：20×20 曲面只画三分之一的线，线在 local 推进时轮换亮灭 */
export const mesh = glyph(ICE, (w, _t, l) => {
  const ni = 17;
  const surf = (x: number, z: number): P => [
    x,
    Math.sin(x * 0.55) * Math.cos(z * 0.5) * 0.8 + 0,
    z,
  ];
  const on = (seed: number): boolean => (l * 1.8 + seed * 0.11) % 1 < 0.62;
  for (let row = 0; row < ni; row += 3) {
    if (!on(row)) continue;
    const z = -5.2 + row * 0.4;
    const pts: P[] = [];
    for (let i = 0; i < ni; i += 1) pts.push(surf(-3.2 + i * 0.4, z));
    w.path(pts);
  }
  for (let col = 1; col < ni; col += 3) {
    if (!on(col + 7)) continue;
    const x = -3.2 + col * 0.4;
    const pts: P[] = [];
    for (let i = 0; i < ni; i += 1) pts.push(surf(x, -5.2 + i * 0.4));
    w.path(pts);
  }
});
