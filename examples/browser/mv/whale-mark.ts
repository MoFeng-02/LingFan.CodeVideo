/**
 * 鲸的轮廓：一条手写的贝塞尔，头朝右、尾在左，长约 148 个设计 px。
 *
 * 这个片子不引任何图片素材，Logo 里的那头小鲸也用它——同一个形状，
 * 只是缩放不同。轮廓不描边、不自带配色，由调用方决定填充与边光。
 */
/** 鲸的轮廓（头朝右、尾在左，长约 148 个设计 px）。落版的小记号也用它。 */
export function whalePath(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
): void {
  const X = (d: number): number => x + d * s;
  const Y = (d: number): number => y + d * s;
  g.beginPath();
  g.moveTo(X(66), Y(2));
  // 钝头：鲸的头是圆的，不能收成一个尖——这是"鲸"和"鱼"最直接的区别。
  g.bezierCurveTo(X(70), Y(-6), X(66), Y(-14), X(56), Y(-18));
  g.bezierCurveTo(X(40), Y(-24), X(18), Y(-27), X(0), Y(-27));
  g.bezierCurveTo(X(-20), Y(-27), X(-36), Y(-22), X(-46), Y(-14));
  g.bezierCurveTo(X(-52), Y(-9), X(-55), Y(-4), X(-56), Y(0));
  // 尾上叶
  g.bezierCurveTo(X(-64), Y(-14), X(-76), Y(-28), X(-86), Y(-30));
  g.bezierCurveTo(X(-83), Y(-20), X(-74), Y(-8), X(-66), Y(-1));
  // 尾下叶
  g.bezierCurveTo(X(-74), Y(7), X(-83), Y(20), X(-86), Y(30));
  g.bezierCurveTo(X(-76), Y(28), X(-64), Y(14), X(-56), Y(2));
  // 腹：深而长的一条弧，回到颌下
  g.bezierCurveTo(X(-44), Y(14), X(-24), Y(21), X(-2), Y(22));
  g.bezierCurveTo(X(24), Y(22), X(48), Y(16), X(58), Y(8));
  g.bezierCurveTo(X(64), Y(5), X(66), Y(3), X(66), Y(2));
  g.closePath();
}
