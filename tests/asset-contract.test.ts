import { describe, expect, it } from "vitest";
import type { AssetLike, AssetSource } from "@lingfan-video/contracts";
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";

const W = 4;
const H = 2;

const painter = () => ({
  data: new Uint8ClampedArray(W * H * 4),
  width: W,
  height: H,
});

function options(assets?: AssetSource) {
  return {
    fps: 10,
    width: W,
    height: H,
    headless: true,
    painter,
    exporter: new FrameSequenceExporter(),
    ...(assets ? { assets } : {}),
  };
}

describe("资产契约：一处声明、载荷原样往返", () => {
  it("异步 setup 经 AssetSource 加载任意产物，载荷原样交给剧本", async () => {
    const payload = { meshes: ["body", "wheel"], materials: 2 };
    const asset: AssetLike = {
      url: "models/robot.gltf",
      kind: "model",
      payload,
    };
    const calls: string[] = [];
    const source: AssetSource = {
      load: async (url) => {
        calls.push(url);
        return asset;
      },
    };
    let received: AssetLike | undefined;
    const scene = start({
      window: 300,
      setup: async (env) => {
        received = await env.assets.load("models/robot.gltf");
      },
      run: (env) => {
        env.step(300, () => {});
      },
    });

    const result = await render(scene, options(source));

    expect(calls).toEqual(["models/robot.gltf"]);
    expect(received).toBe(asset);
    expect(received?.payload).toBe(payload);
    expect(result.frames).toBe(3);
  });

  it("种类是开放集合：适配器自定义名字原样透传", async () => {
    const kinds = [
      "image",
      "audio",
      "video",
      "model",
      "font",
      "data",
      "material:gltf",
      "third-party:scene",
    ];
    const seen: string[] = [];
    const source: AssetSource = {
      load: async (url) => ({ url, kind: url.slice("asset://".length) }),
    };
    for (const kind of kinds) {
      const scene = start({
        window: 100,
        setup: async (env) => {
          seen.push((await env.assets.load(`asset://${kind}`)).kind);
        },
        run: (env) => {
          env.step(100, () => {});
        },
      });
      await render(scene, options(source));
    }
    expect(seen).toEqual(kinds);
  });

  it("同一场景在一次推演里只跑一次 setup（资产只解码一次）", async () => {
    let setupCalls = 0;
    const shared = start({
      window: 100,
      setup: () => {
        setupCalls++;
      },
      run: (env) => {
        env.step(100, () => {});
      },
    });
    const host = start({
      window: 200,
      run: (env) => {
        env.spawn(shared, { key: "copy-a" });
        env.spawn(shared, { key: "copy-b", at: 100 });
        env.step(200, () => {});
      },
    });

    await render(host, options());

    expect(setupCalls).toBe(1);
  });

  it("运行期 spawn 的异步 setup 在帧边界物化：不丢资产也不阻塞帧内", async () => {
    const log: string[] = [];
    const late = start({
      window: 100,
      setup: async () => {
        log.push("late-setup");
      },
      run: (env) => {
        env.step(100, (ctx) => {
          log.push(`late-t${Math.round(ctx.t)}`);
        });
      },
    });
    const host = start({
      window: 500,
      run: (env) => {
        env.step(500, (ctx) => {
          log.push(`host-t${Math.round(ctx.t)}`);
          if (Math.round(ctx.t) === 100) ctx.spawn(late, { key: "late" });
        });
      },
    });

    await render(host, options());

    // setup 在帧边界等完，链从下一个采样点整点开始（内容本地时间 0 对齐）
    expect(log).toContain("late-setup");
    expect(log).toContain("late-t200");
    expect(log.filter((line) => line === "late-setup")).toHaveLength(1);
  });

  it("运行期 spawn 的场景允同步 setup（帧内不等待，但可以准备确定性状态）", async () => {
    const calls: string[] = [];
    const late = start({
      window: 100,
      setup: () => {
        calls.push("late-setup");
      },
      run: (env) => {
        env.step(100, () => {});
      },
    });
    const host = start({
      window: 300,
      run: (env) => {
        env.step(100, (ctx) => {
          ctx.spawn(late, { key: "late" });
        });
      },
    });

    await render(host, options());

    expect(calls).toEqual(["late-setup"]);
  });
});
