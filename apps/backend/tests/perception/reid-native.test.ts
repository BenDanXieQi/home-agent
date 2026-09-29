import { expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { createReidProcess } from "../../src/perception/tracking/reid-process";
import { createReid } from "../../src/perception/tracking/reid";
import { InferenceSession, Tensor } from "onnxruntime-node";
const box = {
  x: 0,
  y: 0,
  w: 96,
  h: 192,
  classId: 0,
  className: "human" as const,
  confidence: 1,
};
async function ready(model: ReturnType<typeof createReidProcess>) {
  model.start();
  const deadline = performance.now() + 10000;
  while (
    !model.status.ready &&
    !model.status.error &&
    performance.now() < deadline
  )
    await delay(10);
  expect(model.status.error).toBeUndefined();
  expect(model.status.ready).toBe(true);
}
test("real model preprocessing crops RGB into raw BGR planar floats and normalizes output", async () => {
  const model = await createReid();
  const reference = await InferenceSession.create(
    new URL("../../models/human_body_reid_v2.onnx", import.meta.url).pathname,
    { executionProviders: ["cpu"], intraOpNumThreads: 1 },
  );
  try {
    const pixels = 96 * 192;
    const rgb = new Uint8Array(2 * pixels * 3);
    for (let y = 0; y < 192; y++)
      for (let x = 96; x < 192; x++) {
        const offset = (y * 192 + x) * 3;
        rgb[offset] = 32;
        rgb[offset + 1] = 96;
        rgb[offset + 2] = 224;
      }
    const actual = await model.extract({
      frame: { width: 192, height: 192, rgb },
      boxes: [{ ...box, x: 96 }],
    });
    const values = new Float32Array(3 * pixels);
    values.fill(224, 0, pixels);
    values.fill(96, pixels, pixels * 2);
    values.fill(32, pixels * 2);
    const input = new Tensor("float32", values, [1, 3, 192, 96]);
    const output = await reference.run({ "input:0": input });
    input.dispose();
    try {
      const vector = output["head/out_emb:0"]!.data;
      if (!(vector instanceof Float32Array))
        throw new Error("Wrong feature type");
      const norm = Math.hypot(...vector);
      expect(actual[0]).toHaveLength(128);
      expect(Math.hypot(...actual[0]!)).toBeCloseTo(1, 6);
      expect(
        Math.max(...actual[0]!.map((v, i) => Math.abs(v - vector[i]! / norm))),
      ).toBeLessThan(0.00001);
    } finally {
      Object.values(output).forEach((value) => {
        value.dispose();
      });
    }
  } finally {
    await model.close();
    await reference.release();
  }
});
test("isolated ReID closes its real process and rejects work after close", async () => {
  const model = createReidProcess();
  try {
    await ready(model);
    const result = await model.extract(
      {
        frame: {
          width: 96,
          height: 192,
          rgb: new Uint8Array(96 * 192 * 3).fill(127),
        },
        boxes: [box],
      },
      1000,
    );
    expect(result).toHaveLength(1);
    expect(Math.hypot(...result[0]!)).toBeCloseTo(1, 6);
  } finally {
    await model.close();
  }
  expect(() => process.kill(model.status.pid!, 0)).toThrow();
  await expect(
    model.extract(
      { frame: { width: 1, height: 1, rgb: new Uint8Array(3) }, boxes: [] },
      1000,
    ),
  ).rejects.toThrow();
});
test("ReID hard deadline ends only its isolated process", async () => {
  const model = createReidProcess();
  try {
    await ready(model);
    await expect(
      model.extract(
        {
          frame: { width: 96, height: 192, rgb: new Uint8Array(96 * 192 * 3) },
          boxes: Array.from({ length: 8 }, () => box),
        },
        1,
      ),
    ).rejects.toThrow("timed out");
  } finally {
    await model.close();
  }
  expect(() => process.kill(model.status.pid!, 0)).toThrow();
});
