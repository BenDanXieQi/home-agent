import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import sharp from "sharp";
import { detectionComputeBudget } from "../../src/perception/compute/budget";

const originalConcurrency = sharp.concurrency();
const originalOrt = { ...(await import("onnxruntime-node")) };

function modelOutput(rows: number[][]) {
  const data = new Float32Array(rows.length * 9);
  rows.forEach((row, index) => {
    row.forEach((value, attribute) => {
      data[attribute * rows.length + index] = value;
    });
  });
  return new originalOrt.Tensor("float32", data, [1, 9, rows.length]);
}

function detectionRow(
  classId: number,
  confidence: number,
  box = [2.5, 2, 0.5, 0.5],
) {
  return [
    ...box,
    ...Array.from({ length: 5 }, (_, index) =>
      index === classId ? confidence : 0,
    ),
  ];
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
  const detector = await createDetector();
  try {
    await check(detector);
  } finally {
    await detector.close();
  }
}

function frame(width = 4, height = 4) {
  return { width, height, rgb: new Uint8Array(width * height * 3).fill(100) };
}

test("evaluation can retain weak candidates without changing the default detection floor", async () => {
  run.mockImplementation(async () => ({
    output0: modelOutput([[2, 2, 2, 2, 0, 0.25, 0, 0, 0]]),
  }));
  const baseline = await createDetector();
  const candidates = await createDetector(0.1);
  try {
    expect((await baseline.detect(frame())).detections).toHaveLength(0);
    expect((await candidates.detect(frame())).detections).toMatchObject([
      { className: "cat", confidence: 0.25 },
    ]);
  } finally {
    await baseline.close();
    await candidates.close();
  }
});

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

test.each([NaN, Infinity, -Infinity, -0.1, 1.1])(
  "rejects invalid confidence %s even outside the winning class",
  async (score) => {
    for (const scores of [
      [score, 0, 0, 0, 0],
      [0.9, 0, 0, 0, score],
    ]) {
      run.mockResolvedValueOnce({
        output0: modelOutput([[2, 2, 2, 2, ...scores]]),
      });
      await withDetector(async (detector) => {
        await expect(detector.detect(frame())).rejects.toThrow(
          "Invalid detection confidence",
        );
      });
    }
  },
);

const petClasses = [
  { className: "cat", classId: 1 },
  { className: "dog", classId: 2 },
];

test.each(petClasses)(
  "retains a weak $className when its mirrored local view has a candidate at the 0.1 floor",
  async ({ className, classId }) => {
    run
      .mockResolvedValueOnce({
        output0: modelOutput([detectionRow(classId, 0.55)]),
      })
      .mockResolvedValueOnce({
        output0: modelOutput([detectionRow(classId, 0.1, [2, 2, 2, 2])]),
      });
    await withDetector(async (detector) => {
      const { detections } = await detector.detect(frame(128, 64));
      expect(detections).toMatchObject([
        { className, x: 72, y: 24, w: 16, h: 16 },
      ]);
      expect(detections[0]?.confidence).toBeCloseTo(0.55);
      expect(run).toHaveBeenCalledTimes(2);
    });
  },
);

test.each(petClasses)(
  "retains a $className when the full mirrored view supports its restored position at 0.5",
  async ({ className, classId }) => {
    run
      .mockResolvedValueOnce({
        output0: modelOutput([detectionRow(classId, 0.55)]),
      })
      .mockResolvedValueOnce({ output0: modelOutput([]) })
      .mockResolvedValueOnce({
        output0: modelOutput([detectionRow(classId, 0.5, [1.5, 2, 0.5, 0.5])]),
      });
    await withDetector(async (detector) => {
      const { detections } = await detector.detect(frame(128, 64));
      expect(detections).toMatchObject([
        { className, x: 72, y: 24, w: 16, h: 16 },
      ]);
      expect(detections[0]?.confidence).toBeCloseTo(0.55);
      expect(run).toHaveBeenCalledTimes(3);
    });
  },
);

test.each(petClasses)(
  "removes an unsupported $className only after both review views fail",
  async ({ classId }) => {
    run
      .mockResolvedValueOnce({
        output0: modelOutput([detectionRow(classId, 0.55)]),
      })
      .mockResolvedValueOnce({ output0: modelOutput([]) })
      .mockResolvedValueOnce({
        output0: modelOutput([detectionRow(classId, 0.3, [1.5, 2, 0.5, 0.5])]),
      });
    await withDetector(async (detector) => {
      expect((await detector.detect(frame(128, 64))).detections).toEqual([]);
      expect(run).toHaveBeenCalledTimes(3);
    });
  },
);

test.each(petClasses)(
  "retains the original $className when a stronger different pet class appears in the mirrored local view",
  async ({ className, classId }) => {
    run
      .mockResolvedValueOnce({
        output0: modelOutput([detectionRow(classId, 0.55)]),
      })
      .mockResolvedValueOnce({
        output0: modelOutput([
          detectionRow(classId === 1 ? 2 : 1, 0.9, [2, 2, 2, 2]),
        ]),
      });
    await withDetector(async (detector) => {
      const { detections } = await detector.detect(frame(128, 64));
      expect(detections).toMatchObject([
        { className, x: 72, y: 24, w: 16, h: 16 },
      ]);
      expect(detections[0]?.confidence).toBeCloseTo(0.55);
      expect(run).toHaveBeenCalledTimes(2);
    });
  },
);

test.each(petClasses)(
  "keeps unrelated original boxes when removing a $className and does not exceed three inferences",
  async ({ className, classId }) => {
    run
      .mockResolvedValueOnce({
        output0: modelOutput([
          detectionRow(classId, 0.55),
          detectionRow(classId, 0.7, [0.75, 2, 0.5, 0.5]),
          detectionRow(4, 0.9, [0.25, 1.5, 0.5, 0.5]),
        ]),
      })
      .mockResolvedValueOnce({ output0: modelOutput([]) })
      .mockResolvedValueOnce({ output0: modelOutput([]) });
    await withDetector(async (detector) => {
      const { detections } = await detector.detect(frame(128, 64));
      expect(detections).toMatchObject([
        { className: "face", x: 0, y: 8, w: 16, h: 16 },
        { className, x: 16, y: 24, w: 16, h: 16 },
      ]);
      expect(detections[0]?.confidence).toBeCloseTo(0.9);
      expect(detections[1]?.confidence).toBeCloseTo(0.7);
      expect(run).toHaveBeenCalledTimes(3);
    });
  },
);

test.each(petClasses)(
  "does not spend review inference on edge-clipped or strong $className detections",
  async ({ className, classId }) => {
    run.mockResolvedValueOnce({
      output0: modelOutput([
        detectionRow(classId, 0.55, [0.25, 2, 0.5, 0.5]),
        detectionRow(classId, 0.8),
      ]),
    });
    await withDetector(async (detector) => {
      const { detections } = await detector.detect(frame(128, 64));
      expect(detections).toMatchObject([
        { className, x: 72, y: 24, w: 16, h: 16 },
        { className, x: 0, y: 24, w: 16, h: 16 },
      ]);
      expect(run).toHaveBeenCalledTimes(1);
    });
  },
);

test("finishes both human reviews before considering a weaker pet and preserves human-to-pet correction", async () => {
  run
    .mockResolvedValueOnce({
      output0: modelOutput([
        detectionRow(0, 0.6),
        detectionRow(0, 0.65, [0.75, 2, 0.5, 0.5]),
        detectionRow(1, 0.51, [1.5, 2, 0.5, 0.5]),
      ]),
    })
    .mockResolvedValueOnce({
      output0: modelOutput([detectionRow(2, 0.9, [2, 2, 2, 2])]),
    })
    .mockResolvedValueOnce({
      output0: modelOutput([detectionRow(0, 0.7, [2, 2, 2, 2])]),
    });
  await withDetector(async (detector) => {
    const { detections } = await detector.detect(frame(128, 64));
    expect(detections).toMatchObject([
      { className: "dog", x: 72, y: 24, w: 16, h: 16 },
      { className: "human", x: 16, y: 24, w: 16, h: 16 },
      { className: "cat", x: 40, y: 24, w: 16, h: 16 },
    ]);
    expect(detections[0]?.confidence).toBeCloseTo(0.9);
    expect(detections[1]?.confidence).toBeCloseTo(0.65);
    expect(run).toHaveBeenCalledTimes(3);
  });
});

test("keeps the human mirror review and its weak support ahead of pet review", async () => {
  run
    .mockResolvedValueOnce({
      output0: modelOutput([
        detectionRow(0, 0.6),
        detectionRow(1, 0.51, [0.75, 2, 0.5, 0.5]),
      ]),
    })
    .mockResolvedValueOnce({ output0: modelOutput([]) })
    .mockResolvedValueOnce({
      output0: modelOutput([detectionRow(0, 0.2, [1.5, 2, 0.5, 0.5])]),
    });
  await withDetector(async (detector) => {
    const { detections } = await detector.detect(frame(128, 64));
    expect(detections).toMatchObject([
      { className: "human", x: 72, y: 24, w: 16, h: 16 },
      { className: "cat", x: 16, y: 24, w: 16, h: 16 },
    ]);
    expect(detections[0]?.confidence).toBeCloseTo(0.6);
    expect(run).toHaveBeenCalledTimes(3);
  });
});

test.each([0.85, 0.95])(
  "deduplicates a human-to-dog correction against an existing dog at confidence %s",
  async (existingConfidence) => {
    run
      .mockResolvedValueOnce({
        output0: modelOutput([
          detectionRow(0, 0.6),
          detectionRow(2, existingConfidence),
        ]),
      })
      .mockResolvedValueOnce({
        output0: modelOutput([detectionRow(2, 0.9, [2, 2, 2, 2])]),
      });
    await withDetector(async (detector) => {
      const { detections } = await detector.detect(frame(128, 64));
      expect(detections).toMatchObject([
        { className: "dog", x: 72, y: 24, w: 16, h: 16 },
      ]);
      expect(detections[0]?.confidence).toBeCloseTo(
        Math.max(0.9, existingConfidence),
      );
      expect(run).toHaveBeenCalledTimes(2);
    });
  },
);
