/**
 * 增益写法：线性幅度（0..∞）或分贝（`{ db: -6 }`）。
 *
 * 两种写法是同一个量的两种记法，换算只有一处实现（core 域层），契约只声明形状：
 * 平台侧（预览 WebAudio / 导出离线混音）永远收到线性幅度，不需要知道作者写的是哪种。
 */
export type GainLike = number | { readonly db: number };
