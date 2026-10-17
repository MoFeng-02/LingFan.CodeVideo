# @lingfan-video/core

Code Video 引擎实现包。域层（编译 / 校验 / 时间）+ 引擎运行时 + 库形态组合根：入口 `src/index.ts` 装配默认适配器，暴露 `start / render / validate / computeAt / computeRange`。

包内依赖方向 `app → domain → contracts`；`app` 不 import `infra`。

能力：时间线驱动逐帧求值、key 化状态聚合、Scheduler/Handle、帧导出、headless 画布桩、契约校验。
