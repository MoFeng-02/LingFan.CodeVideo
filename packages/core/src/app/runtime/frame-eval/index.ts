/**
 * 逐帧求值出口：只交出求值入口。
 *
 * 求值内部按职责拆分——上下文构造（contexts）、能力注入（capabilities）、
 * 消亡窗口（disposal）都在同目录，外部只需要一个「按帧号与时刻求一帧」。
 */
export { evaluateFrame } from "./evaluate";
