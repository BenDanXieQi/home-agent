import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import sharp from "sharp";
import { detectionComputeBudget } from "../../src/perception/compute/budget";

const originalConcurrency = sharp.concurrency();
const originalOrt = { ...(await import("onnxruntime-node")) };

// Fixtures use the model's published [cx, cy, w, h, five class scores] rows.
function modelOutput(rows: number[][]) {
  const data = new Float32Array(rows.length * 9);
  rows.forEach((row, index) => {
    row.forEach((value, attribute) => {
      data[attribute * rows.length + index] = value;
    });
  });
  return new originalOrt.Tensor("float32", data, [1, 9, rows.length]);
}

const release = mock(async () => {});
const run = mock(
  async (_feeds: Record<string, InstanceType<typeof originalOrt.Tensor>>) => ({
    output0: modelOutput([]),
  }),
);
const createSession = mock(async (_path: string, _options: unknown) => ({
  inputNames: ["images"],
  outputNames: ["output0"],
  inputMetadata: [
    {
      name: "images",
      isTensor: true,
      type: "float32",
      shape: [1, 3, 4, 4],
    },
  ],
  outputMetadata: [
    { name: "output0", isTensor: true, type: "float32", shape: [1, 9, 3549] },
  ],
  run,
  release,
}));
await mock.module("onnxruntime-node", () => ({
  ...originalOrt,
  InferenceSession: { create: createSession },
}));
const { createDetector } =
  await import("../../src/perception/detection/detector");

beforeEach(() => {
  release.mockClear();
  createSession.mockClear();
  run.mockReset();
  run.mockImplementation(async () => ({ output0: modelOutput([]) }));
});
afterAll(async () => {
  sharp.concurrency(originalConcurrency);
  await mock.module("onnxruntime-node", () => originalOrt);
});

async function withDetector(
  check: (
    detector: Awaited<ReturnType<typeof createDetector>>,
  ) => Promise<void>,
) {
  const detector = await createDetector("model.onnx");
  try {
    await check(detector);
  } finally {
    await detector.close();
  }
}

function frame(width = 4, height = 4) {
  return { width, height, rgb: new Uint8Array(width * height * 3).fill(100) };
}

test("reuses one session with the explicit CPU and image concurrency budget", async () => {
  sharp.concurrency(10);
  await withDetector(async (detector) => {
    expect(sharp.concurrency()).toBe(detectionComputeBudget.sharpThreads);
    expect(detector.metadata.sharpConcurrency).toBe(sharp.concurrency());
    expect(createSession.mock.calls[0]?.[1]).toEqual({
      executionProviders: ["cpu"],
      executionMode: "sequential",
      intraOpNumThreads: detectionComputeBudget.ortIntraOpThreads,
    });
    await detector.detect(frame());
    await detector.detect(frame());
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });
  expect(release).toHaveBeenCalledTimes(1);
});

test("prepares normalized RGB channel planes with centered 114 padding", async () => {
  run.mockImplementationOnce(async (feeds) => {
    const input = feeds.images!;
    expect(input.dims).toEqual([1, 3, 4, 4]);
    expect(input.type).toBe("float32");
    const data = input.data;
    if (!(data instanceof Float32Array))
      throw new Error("Expected float32 pixels");
    for (let channel = 0; channel < 3; channel++) {
      const plane = Array.from(data.slice(channel * 16, (channel + 1) * 16));
      for (let index = 0; index < plane.length; index++) {
        const expected =
          index < 4 || index >= 12 ? 114 : [255, 128, 0][channel]!;
        expect(plane[index]).toBeCloseTo(expected / 255, 6);
      }
    }
    return { output0: modelOutput([]) };
  });
  await withDetector(async (detector) => {
    await detector.detect({
      width: 2,
      height: 1,
      rgb: new Uint8Array([255, 128, 0, 255, 128, 0]),
    });
  });
});

test("restores a box through both scaling and letterbox padding", async () => {
  run.mockResolvedValueOnce({
    output0: modelOutput([[2, 2, 2, 1, 0.9, 0, 0, 0, 0]]),
  });
  await withDetector(async (detector) => {
    const { detections } = await detector.detect(frame(8, 4));
    expect(detections).toMatchObject([{ x: 2, y: 1, w: 4, h: 2 }]);
  });
});

test.each([
  { width: 1, height: 1 },
  { width: 1, height: 8192 },
  { width: 8192, height: 1 },
])(
  "preserves nonempty boxes in a $width x $height frame",
  async ({ width, height }) => {
    run.mockResolvedValueOnce({
      output0: modelOutput([[2, 2, 4, 4, 0.9, 0, 0, 0, 0]]),
    });
    await withDetector(async (detector) => {
      const { detections } = await detector.detect(frame(width, height));
      expect(detections).toMatchObject([{ x: 0, y: 0, w: width, h: height }]);
    });
  },
);

test("clips boxes at all image edges without dropping the final row or column", async () => {
  run.mockResolvedValueOnce({
    output0: modelOutput([
      [0, 0, 2, 2, 0.9, 0, 0, 0, 0],
      [4, 4, 2, 2, 0.8, 0, 0, 0, 0],
    ]),
  });
  await withDetector(async (detector) => {
    const { detections } = await detector.detect(frame());
    expect(detections).toMatchObject([
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 3, y: 3, w: 1, h: 1 },
    ]);
  });
});

test("rounds fractional coverage outwards while discarding empty and inverted boxes", async () => {
  run.mockResolvedValueOnce({
    output0: modelOutput([
      [1.5, 1.5, 1.5, 1.5, 0.9, 0, 0, 0, 0],
      [1.5, 1.5, 0, 1, 0.9, 0, 0, 0, 0],
      [1.5, 1.5, -0.25, 1, 0.9, 0, 0, 0, 0],
      [-1, 2, 1, 1, 0.9, 0, 0, 0, 0],
    ]),
  });
  await withDetector(async (detector) => {
    const { detections } = await detector.detect(frame());
    expect(detections).toMatchObject([{ x: 0, y: 0, w: 3, h: 3 }]);
  });
});

test("keeps the strongest class, suppresses same-class overlap, and includes the confidence boundary", async () => {
  run.mockResolvedValueOnce({
    output0: modelOutput([
      [2, 2, 4, 4, 0.8, 0, 0, 0, 0],
      [2, 2, 4, 4, 0.9, 0, 0, 0, 0],
      [2, 2, 4, 4, 0.6, 0.7, 0, 0, 0],
      [1, 1, 2, 2, 0.6, 0, 0, 0, 0],
      [3, 3, 2, 2, 0, 0, 0.49, 0, 0],
      [3, 3, 2, 2, 0, 0, 0.5, 0, 0],
    ]),
  });
  await withDetector(async (detector) => {
    const { detections } = await detector.detect(frame());
    expect(detections).toMatchObject([
      { className: "human", classId: 0, x: 0, y: 0, w: 4, h: 4 },
      { className: "cat", classId: 1, x: 0, y: 0, w: 4, h: 4 },
      { className: "human", classId: 0, x: 0, y: 0, w: 2, h: 2 },
      { className: "dog", classId: 2, x: 2, y: 2, w: 2, h: 2 },
    ]);
    expect(detections[0]?.confidence).toBeCloseTo(0.9);
    expect(detections[3]?.confidence).toBe(0.5);
  });
});

test("keeps boxes whose continuous IoU is below 0.7 even when rounded boxes overlap more", async () => {
  // After scaling back to 16x16: x edges [0.1,10.1] and [1.9,11.9],
  // both y edges [0,10]. Continuous IoU is 8.2 / 11.8, about 0.695.
  run.mockResolvedValueOnce({
    output0: modelOutput([
      [1.275, 1.25, 2.5, 2.5, 0.9, 0, 0, 0, 0],
      [1.725, 1.25, 2.5, 2.5, 0.8, 0, 0, 0, 0],
    ]),
  });
  await withDetector(async (detector) => {
    const { detections } = await detector.detect(frame(16, 16));
    expect(detections).toMatchObject([
      { className: "human", x: 0, y: 0, w: 11, h: 10 },
      { className: "human", x: 1, y: 0, w: 11, h: 10 },
    ]);
  });
});

test("suppresses the weaker same-class box when continuous IoU exceeds 0.7", async () => {
  // x edges [0.1,10.1] and [1.8,11.8]: continuous IoU is 8.3 / 11.7.
  run.mockResolvedValueOnce({
    output0: modelOutput([
      [1.275, 1.25, 2.5, 2.5, 0.9, 0, 0, 0, 0],
      [1.7, 1.25, 2.5, 2.5, 0.8, 0, 0, 0, 0],
    ]),
  });
  await withDetector(async (detector) => {
    const { detections } = await detector.detect(frame(16, 16));
    expect(detections).toMatchObject([
      { className: "human", x: 0, y: 0, w: 11, h: 10 },
    ]);
    expect(detections[0]?.confidence).toBeCloseTo(0.9);
  });
});

test("preserves distinct subpixel boxes and nonempty image-edge coverage", async () => {
  run.mockResolvedValueOnce({
    output0: modelOutput([
      [0.25, 0.25, 0.3, 0.3, 0.9, 0, 0, 0, 0],
      [0.75, 0.25, 0.3, 0.3, 0.8, 0, 0, 0, 0],
      [4, 3.75, 0.4, 0.3, 0.7, 0, 0, 0, 0],
    ]),
  });
  await withDetector(async (detector) => {
    const { detections } = await detector.detect(frame());
    expect(detections).toMatchObject([
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 3, y: 3, w: 1, h: 1 },
    ]);
  });
});

test("disposes input and output tensors after successful inference", async () => {
  let input: InstanceType<typeof originalOrt.Tensor> | undefined;
  const output = modelOutput([]);
  run.mockImplementationOnce(async (feeds) => {
    input = feeds.images;
    return { output0: output };
  });
  await withDetector(async (detector) => {
    await detector.detect(frame());
    expect(() => input?.data).toThrow("disposed");
    expect(() => output.data).toThrow("disposed");
  });
});

test("disposes the input tensor when native inference rejects", async () => {
  let input: InstanceType<typeof originalOrt.Tensor> | undefined;
  run.mockImplementationOnce(async (feeds) => {
    input = feeds.images;
    throw new Error("native inference failed");
  });
  await withDetector(async (detector) => {
    await expect(detector.detect(frame())).rejects.toThrow(
      "native inference failed",
    );
    expect(() => input?.data).toThrow("disposed");
  });
});
