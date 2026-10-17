# @lingfan-video/core

Code Video 引擎实现包。依赖方向：`app / infra / domain → @lingfan-video/contracts`，`app` 与 `infra` 互不 import。入口 `src/index.ts` 是库形态组合根：装配默认适配器并暴露 `start / render / validate / computeAt / computeRange`。

- 当前版本已实现：时间线驱动逐帧求值、key 化状态聚合、Scheduler/Handle、frames 导出器、headless 画布桩、validate 契约检查
- 后续版本边界：WebCodecs/FFmpeg 编码导出、音频确定性渲染、AI 资产 pin 缓存
