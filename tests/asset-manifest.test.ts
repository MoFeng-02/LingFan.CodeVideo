import { describe, expect, it } from "vitest";
import type {
  AssetLike,
  AssetManifest,
  AssetSource,
} from "@lingfan-video/contracts";
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

/** 场景：在 setup 里按引用取一次资产，把拿到的载荷交给断言 */
function sceneWithLoad(ref: string, onLoad: (asset: AssetLike) => void) {
  return start({
    window: 100,
    setup: async (env) => {
      onLoad(await env.assets.load(ref));
    },
    run: (env) => {
      env.step(100, () => {});
    },
  });
}

function sourceOf(
  manifest: AssetManifest | undefined,
  assets: readonly AssetLike[],
  log: string[],
): AssetSource {
  return {
    load: async (ref) => {
      log.push(ref);
      const hit = assets.find((a) => a.url === ref);
      if (!hit) throw new Error(`假适配器没有 ${ref}`);
      return hit;
    },
    ...(manifest === undefined ? {} : { manifest: () => manifest }),
  };
}

describe("资产清单：id → url → 内容指纹", () => {
  it("按 id 取资产：引擎解析成 url，载荷原样交给剧本", async () => {
    const payload = { meshes: ["body"] };
    const log: string[] = [];
    const source = sourceOf(
      {
        entries: [{ id: "robot", url: "models/robot.gltf", kind: "model" }],
      },
      [{ url: "models/robot.gltf", kind: "model", payload }],
      log,
    );
    let received: AssetLike | undefined;
    const result = await render(
      sceneWithLoad("robot", (asset) => {
        received = asset;
      }),
      options(source),
    );

    expect(log).toEqual(["models/robot.gltf"]);
    expect(received?.payload).toBe(payload);
    expect(result.frames).toBe(1);
  });

  it("清单外引用在第一帧之前失败", async () => {
    const log: string[] = [];
    const source = sourceOf(
      { entries: [{ id: "robot", url: "models/robot.gltf" }] },
      [{ url: "models/robot.gltf", kind: "model" }],
      log,
    );
    const scene = sceneWithLoad("ghost", () => {});

    await expect(render(scene, options(source))).rejects.toThrow(
      /资产不在清单里：ghost/,
    );
    expect(log).toEqual([]);
  });

  it("内容指纹一致才放行", async () => {
    const log: string[] = [];
    const manifest: AssetManifest = {
      entries: [
        { id: "pad", url: "audio/pad.wav", kind: "audio", hash: "sha256:aa" },
      ],
    };
    const source = sourceOf(
      manifest,
      [{ url: "audio/pad.wav", kind: "audio", hash: "sha256:aa" }],
      log,
    );

    const result = await render(
      sceneWithLoad("pad", () => {}),
      options(source),
    );

    expect(result.frames).toBe(1);
  });

  it("内容指纹不一致明确失败", async () => {
    const log: string[] = [];
    const source = sourceOf(
      {
        entries: [
          {
            id: "pad",
            url: "audio/pad.wav",
            kind: "audio",
            hash: "sha256:aa",
          },
        ],
      },
      [{ url: "audio/pad.wav", kind: "audio", hash: "sha256:bb" }],
      log,
    );

    await expect(
      render(
        sceneWithLoad("pad", () => {}),
        options(source),
      ),
    ).rejects.toThrow(/资产内容与清单不符：audio\/pad.wav/);
  });

  it("清单要求指纹但适配器没报，同样失败", async () => {
    const log: string[] = [];
    const source = sourceOf(
      { entries: [{ id: "pad", url: "audio/pad.wav", hash: "sha256:aa" }] },
      [{ url: "audio/pad.wav", kind: "audio" }],
      log,
    );

    await expect(
      render(
        sceneWithLoad("pad", () => {}),
        options(source),
      ),
    ).rejects.toThrow(/资产未报告内容指纹/);
  });

  it("种类与清单不符失败", async () => {
    const log: string[] = [];
    const source = sourceOf(
      { entries: [{ id: "pad", url: "audio/pad.wav", kind: "audio" }] },
      [{ url: "audio/pad.wav", kind: "video" }],
      log,
    );

    await expect(
      render(
        sceneWithLoad("pad", () => {}),
        options(source),
      ),
    ).rejects.toThrow(/资产种类与清单不符/);
  });

  it("清单 id 与 url 都必须唯一", async () => {
    const duplicateId = sourceOf(
      {
        entries: [
          { id: "pad", url: "a.wav" },
          { id: "pad", url: "b.wav" },
        ],
      },
      [],
      [],
    );
    await expect(
      render(
        sceneWithLoad("pad", () => {}),
        options(duplicateId),
      ),
    ).rejects.toThrow(/id 重复：pad/);

    const duplicateUrl = sourceOf(
      {
        entries: [
          { id: "a", url: "a.wav" },
          { id: "b", url: "a.wav" },
        ],
      },
      [],
      [],
    );
    await expect(
      render(
        sceneWithLoad("a", () => {}),
        options(duplicateUrl),
      ),
    ).rejects.toThrow(/url 重复：a\.wav/);
  });

  it("一次推演内同一资产只加载一次（跨场景共享缓存）", async () => {
    const log: string[] = [];
    const payload = { id: 1 };
    const child = start({
      window: 100,
      setup: async (env) => {
        await env.assets.load("robot");
      },
      run: (env) => {
        env.step(100, () => {});
      },
    });
    const host = start({
      window: 100,
      setup: async (env) => {
        await env.assets.load("models/robot.gltf");
      },
      run: (env) => {
        env.spawn(child, { key: "child" });
        env.step(100, () => {});
      },
    });
    const source = sourceOf(
      { entries: [{ id: "robot", url: "models/robot.gltf" }] },
      [{ url: "models/robot.gltf", kind: "model", payload }],
      log,
    );

    await render(host, options(source));

    expect(log).toEqual(["models/robot.gltf"]);
  });

  it("缓存按推演隔离：两次 render 各加载一次", async () => {
    const log: string[] = [];
    const scene = sceneWithLoad("robot", () => {});
    const source = sourceOf(
      { entries: [{ id: "robot", url: "models/robot.gltf" }] },
      [{ url: "models/robot.gltf", kind: "model" }],
      log,
    );

    await render(scene, options(source));
    await render(scene, options(source));

    expect(log).toEqual(["models/robot.gltf", "models/robot.gltf"]);
  });

  it("没有清单的适配器保持向后兼容：引用就是 url", async () => {
    const log: string[] = [];
    const source = sourceOf(
      undefined,
      [{ url: "audio/pad.wav", kind: "audio" }],
      log,
    );

    const result = await render(
      sceneWithLoad("audio/pad.wav", () => {}),
      options(source),
    );

    expect(log).toEqual(["audio/pad.wav"]);
    expect(result.frames).toBe(1);
  });
});
