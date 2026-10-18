/**
 * 后半程图形（mix → settle）：从两半拼接、走廊、环视到收束的九镜。
 *
 * 与前半程同一套纪律：纯函数、无跨帧状态、只写线段；端点不出
 * |x|≤3.6、|y|≤2.2、z∈[-6,6]，同一镜内不重复写线。
 */
import { BRAND, DIM, ICE, INK, glyph, smooth, type P } from "./lines";

/** 左曲面、右节点环、中间一条把两边接起来的亮线 */
export const mix = glyph(BRAND, (w, _t, _l) => {
  const surf = (x: number, z: number): P => [
    x,
    Math.sin(x * 0.6) * Math.cos(z * 0.5) * 0.7 + 0,
    z,
  ];
  for (let row = 0; row < 6; row += 1) {
    const z = -3.6 + row * 0.7;
    const pts: P[] = [];
    for (let i = 0; i < 11; i += 1) pts.push(surf(-3.4 + i * 0.25, z));
    w.path(pts);
  }
  for (let col = 0; col < 5; col += 1) {
    const x = -3.4 + col * 0.62;
    const pts: P[] = [];
    for (let i = 0; i < 9; i += 1) pts.push(surf(x, -3.2 + i * 0.4));
    w.path(pts);
  }
  const node = (i: number): P => [
    2.2 + Math.cos((i / 12) * Math.PI * 2) * 1.2,
    0,
    -1.2 + Math.sin((i / 12) * Math.PI * 2) * 1.2,
  ];
  for (let i = 0; i < 12; i += 1) {
    const [x, , z] = node(i);
    w.line([x - 0.1, 0, z], [x + 0.1, 0, z]);
    w.line([x, 0, z - 0.1], [x, 0, z + 0.1]);
  }
  for (let i = 0; i < 12; i += 1) w.line(node(i), node(i + 1));
  w.path([node(6), [-0.9, 0.3, -2]]);
});

/** 纵深走廊：方框按 z 排开，local 推进时最近的方框向前掠过 */
export const corridor = glyph(ICE, (w, _t, l) => {
  for (let i = 0; i < 18; i += 1) {
    const z = -6 + i * 0.66 + l * 0.6;
    w.path([
      [-2.4, -2, z],
      [2.4, -2, z],
      [2.4, 2, z],
      [-2.4, 2, z],
      [-2.4, -2, z],
    ]);
  }
  w.line([-2.4, 0.3, 5.8], [-2.4, 0.3, -6]);
  w.line([2.4, 0.3, 5.8], [2.4, 0.3, -6]);
});

/** 两块平行大平面：一块密（深）、一块疏（快），各朝相反方向平移 */
export const tiers = glyph(BRAND, (w, _t, l) => {
  const denseDx = l * 0.35;
  for (let i = 0; i < 17; i += 1) {
    const x = -3.2 + i * 0.4 + denseDx;
    w.line([x, 0.6, -5.6], [x, 0.6, -0.8]);
  }
  for (let i = 0; i < 13; i += 1) {
    const z = -5.6 + i * 0.4;
    w.line([-3.2 + denseDx, 0.6, z], [3.2 + denseDx, 0.6, z]);
  }
  const sparseDx = -l * 0.5;
  for (let i = 0; i < 6; i += 1) {
    const x = -2.6 + i * 1.1 + sparseDx;
    w.line([x, -0.6, -5.6], [x, -0.6, -1.6]);
  }
  for (let i = 0; i < 5; i += 1) {
    const z = -5.6 + i;
    w.line([-2.6 + sparseDx, -0.6, z], [2.9 + sparseDx, -0.6, z]);
  }
});

/** 同心圆 + 放射线 + 中心亮十字；local 推进时圆环外扩、放射线扫过 */
export const eye = glyph(INK, (w, _t, l) => {
  const grow = 0.2 * smooth(l);
  for (const base of [0.4, 0.8, 1.2, 1.6, 2.0]) {
    const rad = base + grow;
    for (let i = 0; i < 48; i += 1) {
      const a0 = (i / 48) * Math.PI * 2;
      const a1 = ((i + 1) / 48) * Math.PI * 2;
      w.line(
        [Math.cos(a0) * rad, Math.sin(a0) * rad, 0],
        [Math.cos(a1) * rad, Math.sin(a1) * rad, 0],
      );
    }
  }
  for (let i = 0; i < 24; i += 1) {
    const a = (i / 24) * Math.PI * 2 + l * 0.9;
    w.line(
      [Math.cos(a) * 0.45, Math.sin(a) * 0.45, 0],
      [Math.cos(a) * 2.15, Math.sin(a) * 2.15, 0],
    );
  }
  w.line([-0.14, 0, 0], [0.14, 0, 0]);
  w.line([0, -0.14, 0], [0, 0.14, 0]);
});

/** 线框物体从零被画出来：底面网格 → 竖棱 → 顶面，三段各不相同 */
export const construct = glyph(BRAND, (w, _t, l) => {
  const p = smooth(l);
  const x0 = -2;
  const x1 = 2;
  const yb = -1.9;
  const yt = 0.8;
  const z0 = -4.2;
  const z1 = -1.2;
  const frame = (y: number, prog: number): void => {
    const seg = (a: P, b: P, start: number): void => {
      const q = smooth((prog - start) / 0.34);
      if (q <= 0) return;
      w.line(a, [
        a[0] + (b[0] - a[0]) * q,
        a[1] + (b[1] - a[1]) * q,
        a[2] + (b[2] - a[2]) * q,
      ]);
    };
    for (let i = 0; i < 3; i += 1) {
      const x = x0 + ((x1 - x0) * i) / 2;
      seg([x, y, z0], [x, y, z1], i * 0.12);
    }
    for (let i = 0; i < 3; i += 1) {
      const z = z0 + ((z1 - z0) * i) / 2;
      seg([x0, y, z], [x1, y, z], 0.18 + i * 0.12);
    }
  };
  frame(yb, p);
  if (p > 0.3) {
    const q = smooth((p - 0.3) / 0.38);
    const corners: ReadonlyArray<readonly [number, number]> = [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ];
    for (const [x, z] of corners) {
      w.line([x, yb, z], [x, yb + (yt - yb) * q, z]);
    }
  }
  frame(yt, (p - 0.64) / 0.36);
});

/** 闭环赛道：两条路边 + 一条中心线，从起点向终点长出来 */
export const track = glyph(ICE, (w, _t, l) => {
  const at = (i: number): { p: P; n: P } => {
    const a = -Math.PI / 2 + (i / 40) * Math.PI * 2;
    // 椭圆法线 (b·cos, a·sin) 的模长下界是 b，非零；仍留兜底防坏值
    const len = Math.hypot(Math.cos(a) * 2, Math.sin(a) * 3) || 2;
    return {
      p: [Math.cos(a) * 3, 0, Math.sin(a) * 2],
      n: [(Math.cos(a) * 2) / len, 0, (Math.sin(a) * 3) / len],
    };
  };
  const off = (i: number, side: number): P => {
    const { p, n } = at(i);
    return [p[0] + n[0] * side, 0, p[2] + n[2] * side];
  };
  const n = Math.max(1, Math.ceil(39 * smooth(l)));
  for (let i = 0; i < n; i += 1) {
    w.line(at(i).p, at(i + 1).p);
    w.line(off(i, 0.5), off(i + 1, 0.5));
    w.line(off(i, -0.5), off(i + 1, -0.5));
  }
});

/** 俯视灰盒关卡：外框 + 两个平台 + 门洞 + 从起点到门的折线 */
export const godot = glyph(DIM, (w, _t, l) => {
  w.path([
    [-3.4, -2, 0],
    [3.4, -2, 0],
    [3.4, 2, 0],
    [-3.4, 2, 0],
    [-3.4, -2, 0],
  ]);
  w.path([
    [-3.2, -1.2, 0],
    [-1.2, -1.2, 0],
    [-1.2, -0.2, 0],
    [-3.2, -0.2, 0],
    [-3.2, -1.2, 0],
  ]);
  w.path([
    [0.5, -0.4, 0],
    [0.5, 0.8, 0],
    [3.2, 0.8, 0],
    [3.2, -0.4, 0],
    [0.5, -0.4, 0],
  ]);
  w.path([
    [2.2, -2, 0],
    [2.2, -1, 0],
    [3, -1, 0],
    [3, -2, 0],
  ]);
  const route: P[] = [
    [-3.2, -1.6, 0],
    [-2.2, -0.9, 0],
    [-2.2, 0.4, 0],
    [-1.6, 1.1, 0],
    [-0.5, 1.1, 0],
    [-0.5, -1.3, 0],
    [2.2, -1.3, 0],
  ];
  const n = Math.max(2, Math.ceil(route.length * smooth(l)));
  w.path(route.slice(0, n));
});

/** 一个环：三段顺时针箭头，高亮从生成→测试→修正轮转 */
export const loop = glyph(BRAND, (w, _t, l) => {
  const at = (a: number): P => [Math.cos(a) * 2, Math.sin(a) * 2, 0];
  const active = Math.floor(l * 3) % 3;
  for (let k = 0; k < 3; k += 1) {
    const a0 = Math.PI / 2 - (k * Math.PI * 2) / 3;
    const a1 = Math.PI / 2 - ((k + 1) * Math.PI * 2) / 3;
    const steps = 8;
    for (let i = 0; i < steps; i += 1) {
      const u0 = a0 + ((a1 - a0) * i) / steps;
      const u1 = a0 + ((a1 - a0) * (i + 1)) / steps;
      w.line(at(u0), at(u1));
    }
    // 箭头只在终点往回折两小段，不覆盖弧线
    const tip = at(a1);
    const bx = -Math.sin(a1) * 0.25;
    const by = Math.cos(a1) * 0.25;
    const px = Math.cos(a1) * 0.14;
    const py = Math.sin(a1) * 0.14;
    w.line(tip, [tip[0] + bx + px, tip[1] + by + py, 0]);
    w.line(tip, [tip[0] + bx - px, tip[1] + by - py, 0]);
  }
  for (let i = 0; i < 3; i += 1) {
    const angle = Math.PI / 2 - (i * Math.PI * 2) / 3;
    const p = at(angle);
    const s = i === active ? 0.2 : 0.1;
    // 斜十字，避免与圆周上水平/垂直的弧段共线
    w.line([p[0] - s, p[1] - s, -0.03], [p[0] + s, p[1] + s, -0.03]);
    w.line([p[0] - s, p[1] + s, -0.03], [p[0] + s, p[1] - s, -0.03]);
  }
});

/** 收束：全部塌回一条水平线，残余竖线一根根消失 */
export const settle = glyph(INK, (w, _t, l) => {
  const fade = smooth(l / 0.95);
  w.line([-3.6, 0, 0], [3.6, 0, 0]);
  for (let i = 0; i < 13; i += 1) {
    const x = -3.2 + i * (6.4 / 12);
    if (fade > (i + 1) / 14) continue;
    const h = 0.55 * (1 - fade);
    w.line([x, 0, 0.02], [x, h, 0.02]);
  }
});
