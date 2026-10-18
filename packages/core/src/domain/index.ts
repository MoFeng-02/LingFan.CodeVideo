/**
 * 域层出口：时间换算、模拟/编译/聚合、结构校验。
 *
 * 这里只聚合「纯域」模块；音频组合子、程序随机源与违约构造分别由上层按需深引，
 * 不进这个桶，以免域出口被平台细节或可选能力撑大。
 */
export * from "./time-math";
export * from "./simulation";
export * from "./validation";
