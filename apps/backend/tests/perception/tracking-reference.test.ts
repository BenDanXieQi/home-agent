import { expect, test } from "bun:test";
import { createInferencePool } from "../../src/perception/compute/inference-pool";
import { createReidProcess } from "../../src/perception/tracking/reid-process";
import { createTrackingRuntime } from "../../src/perception/tracking/runtime";

function frame() {
  return {
    width: 96,
    height: 192,
    rgb: new Uint8Array(96 * 192 * 3),
  };
}

test("a rejected photo reference does not reduce later detection concurrency", async () => {
  const pool = createInferencePool(
    (error) => {
      throw error;
    },
    { availableCpus: 2, cpuRatio: 1, workersPerProcess: 2 },
  );
  await pool.submit({ kind: "initialize" });
  const tracking = createTrackingRuntime({
    reserveCompute: (waitForCapacity) => pool.reserveTracking(waitForCapacity),
    releaseCompute: () => {
      pool.releaseTracking();
    },
    createModel: createReidProcess,
    emit: async () => {},
    failure: (error) => {
      throw error;
    },
    fatal: (error) => {
      throw error;
    },
  });
  const admission = Promise.withResolvers<void>();
  const first = pool.submit(
    { kind: "detect", frame: frame() },
    () => admission.promise,
  );
  const second = pool.submit(
    { kind: "detect", frame: frame() },
    () => admission.promise,
  );
  try {
    await expect(
      tracking.extractReference(
        { path: "/unused-busy-reference" },
        [
          {
            trackId: 1,
            className: "human",
            measuredBox: { x: 0, y: 0, w: 96, h: 192 },
          },
        ],
        1000,
      ),
    ).rejects.toMatchObject({ code: "busy" });
    expect(tracking.referenceModelStatus().status).toBe("not_checked");
    admission.resolve();
    await Promise.all([first, second]);

    const nextAdmission = Promise.withResolvers<void>();
    const next = pool.submit(
      { kind: "detect", frame: frame() },
      () => nextAdmission.promise,
    );
    try {
      expect(pool.available).toBe(true);
    } finally {
      nextAdmission.resolve();
      await next;
    }
  } finally {
    admission.resolve();
    await Promise.allSettled([first, second]);
    await tracking.close();
    await pool.close();
  }
});
