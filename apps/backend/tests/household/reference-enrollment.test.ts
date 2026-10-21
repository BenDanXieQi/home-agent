import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageDetectionResponseSchema } from "@home-agent/api/contracts";
import { createDatabase } from "../../src/db";
import { createReferenceEnrollment } from "../../src/household/identity/enrollment";
import { createReferenceFiles } from "../../src/household/identity/files";
import { createIdentityReferences } from "../../src/household/identity/references";
import { createIdentityRoutes } from "../../src/household/identity/routes";
import {
  createMijiaHousehold,
  createMijiaSpecificationLoader,
} from "../../src/mijia/household";
import { MiotSpecClient } from "../../src/mijia/protocols/spec/client";
import { MijiaService } from "../../src/mijia/service";
import { identityConfigSchema } from "../../src/perception/identity/config";
import { enrollmentResultSchema } from "../../src/perception/identity/enrollment-protocol";
import { identityProcessingVersions } from "../../src/perception/identity/processing-version";
import { createPerceptionService } from "../../src/perception/service";
import { runFfmpeg } from "../../src/media/ffmpeg";
import {
  credentialStore,
  homeSelectionStore,
} from "../support/account-fixtures";
import { deferred, nextTurn } from "../support/async";

const noFace = enrollmentResultSchema.parse({
  kind: "enrollment",
  candidates: [],
  reason: "未检测到人脸",
});
const detection = imageDetectionResponseSchema.parse({
  kind: "image_detected",
  inputSha256: "a".repeat(64),
  width: 96,
  height: 192,
  detections: [],
  timing: {
    readMs: 0,
    decodeMs: 0,
    preprocessMs: 0,
    inferenceMs: 0,
    postprocessMs: 0,
    queueMs: 0,
    workerDispatchMs: 0,
    totalMs: 0,
    dispatchMs: 0,
    ipcRoundTripMs: 0,
  },
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "reference-enrollment-test-"));
  const database = createDatabase(
    "postgres://unused:unused@127.0.0.1:1/unused",
  );
  const references = createIdentityReferences(
    database.db,
    createReferenceFiles(join(directory, "references")),
  );
  const versions = identityProcessingVersions().adapters.human;
  const listing = spyOn(references, "list").mockResolvedValue({
    kind: "person",
    className: "human",
    samples: [],
    enabled: false,
    usable: false,
  });
  const referenceVersions = spyOn(
    references.matching,
    "referenceVersions",
  ).mockReturnValue(versions);
  const household = createMijiaHousehold(
    new MijiaService({
      credentialStore: credentialStore(),
      homeSelectionStore: homeSelectionStore(),
      readGo2rtcUrl: async () => {
        throw new Error("Media connections are outside this fixture");
      },
    }),
    undefined,
    createMijiaSpecificationLoader(new MiotSpecClient(1024)),
  );
  const member = {
    memberId: crypto.randomUUID(),
    scope_epoch: household.epoch,
  };
  const sources = {
    list: () => [],
    eligibility: () => ({
      scopeEpoch: member.scope_epoch,
      householdVersion: { scope_epoch: member.scope_epoch, sequence: 1 },
      identity: "fixture-source",
    }),
    subscribe: () => () => {},
    prepare: async () => {
      throw new Error("Camera access is outside this fixture");
    },
  };
  const perception = createPerceptionService({
    configPath: join(directory, "unused.json"),
    executable: "ffmpeg",
    sources,
  });
  const config = spyOn(perception, "identityConfig").mockReturnValue(
    identityConfigSchema.parse({ modelDirectory: "/unused-models" }),
  );
  const detect = spyOn(perception, "detectImage").mockImplementation(
    async (image) => {
      await readFile(image.path);
      return { ...detection, imagePath: image.path };
    },
  );
  const extract = spyOn(perception, "enrollment").mockResolvedValue(noFace);
  const enrollment = createReferenceEnrollment(
    references,
    perception,
    () => ({
      identity: { accountId: "fixture-account", homeId: "fixture-home" },
      snapshot: household.snapshot(),
      assertCurrent() {},
    }),
    { executable: "ffmpeg", sources },
  );
  const app = createIdentityRoutes({
    port: 4000,
    household,
    shutdown: new AbortController().signal,
    timeoutMs: 5000,
    enrollment,
    references,
  });
  function input() {
    return { ...member, sessionId: crypto.randomUUID() };
  }
  async function request(path: string, init: RequestInit = {}) {
    return await app.request(
      `http://localhost:4000${path}`,
      {
        ...init,
        headers: {
          host: "localhost:4000",
          ...Object.fromEntries(new Headers(init.headers)),
        },
      },
      {
        requestIP: () => ({
          address: "127.0.0.1",
          port: 50000,
          family: "IPv4",
        }),
      },
    );
  }
  function json(path: string, value: unknown) {
    return request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  }
  function upload(selected: ReturnType<typeof input>, signal?: AbortSignal) {
    const body = new FormData();
    body.append("images", new File(["fixture-photo"], "person.jpg"));
    return request(`/upload?${new URLSearchParams(selected).toString()}`, {
      method: "POST",
      body,
      ...(signal ? { signal } : {}),
    });
  }
  async function close() {
    enrollment.close();
    for (const boundary of [
      listing,
      referenceVersions,
      config,
      detect,
      extract,
    ])
      boundary.mockRestore();
    await perception.close();
    await household.close();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
  return {
    directory,
    enrollment,
    extract,
    input,
    request,
    json,
    upload,
    close,
  };
}

test("cancel waits for admitted extraction and temporary-file cleanup before the next upload", async () => {
  const h = await fixture();
  const started = deferred<string>();
  const release = deferred();
  h.extract.mockImplementationOnce(async (command) => {
    if (command.kind !== "identity_extract")
      throw new Error("Expected reference extraction");
    started.resolve(command.image.path);
    await release.promise;
    return noFace;
  });
  const selected = h.input();
  const uploading = h.upload(selected);
  const path = await started.promise;
  let cancelled = false;
  const cancellation = h.json("/cancel", selected).then((response) => {
    cancelled = true;
    return response;
  });
  try {
    await nextTurn();
    expect(cancelled).toBe(false);
    expect(await Bun.file(path).exists()).toBe(true);
    release.resolve();
    expect((await cancellation).status).toBe(200);
    expect(await (await uploading).json()).toMatchObject({
      code: "request_cancelled",
    });
    expect(await Bun.file(path).exists()).toBe(false);

    const next = h.input();
    const response = await h.upload(next);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessionId: next.sessionId });
  } finally {
    release.resolve();
    await Promise.allSettled([uploading, cancellation]);
    await h.close();
  }
});

test("a client-known session can be cancelled after the upload response is lost", async () => {
  const h = await fixture();
  const selected = h.input();
  try {
    const response = await h.upload(selected);
    expect(response.status).toBe(200);
    expect((await h.enrollment.poll(selected)).sessionId).toBe(
      selected.sessionId,
    );
    expect((await h.json("/cancel", selected)).status).toBe(200);
    expect((await h.json("/preview", selected)).status).toBe(410);
    expect((await h.upload(h.input())).status).toBe(200);
  } finally {
    await h.close();
  }
});

test("an old cancellation neither aborts nor removes a newer registration", async () => {
  const h = await fixture();
  const previous = h.input();
  const selected = h.input();
  const started = deferred();
  const release = deferred();
  try {
    expect((await h.upload(previous)).status).toBe(200);
    expect((await h.json("/cancel", previous)).status).toBe(200);
    h.extract.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return noFace;
    });
    const uploading = h.upload(selected);
    try {
      await started.promise;
      expect((await h.json("/cancel", previous)).status).toBe(200);
      release.resolve();
      const response = await uploading;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        sessionId: selected.sessionId,
      });
      expect((await h.json("/cancel", previous)).status).toBe(200);
      expect(await (await h.json("/preview", selected)).json()).toMatchObject({
        sessionId: selected.sessionId,
      });
    } finally {
      release.resolve();
      await uploading;
    }
  } finally {
    await h.close();
  }
});

test("a known upload can be cancelled while its multipart body is still arriving", async () => {
  const h = await fixture();
  const selected = h.input();
  const started = deferred();
  const release = deferred();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull() {
        started.resolve();
        await release.promise;
      },
    },
    { highWaterMark: 0 },
  );
  const uploading = h.request(
    `/upload?${new URLSearchParams(selected).toString()}`,
    {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=fixture" },
      body,
    },
  );
  try {
    await started.promise;
    expect((await h.json("/cancel", selected)).status).toBe(200);
    expect(await (await uploading).json()).toMatchObject({
      code: "request_cancelled",
    });
    expect(h.extract).not.toHaveBeenCalled();
    expect((await h.upload(h.input())).status).toBe(200);
  } finally {
    release.resolve();
    await uploading;
    await h.close();
  }
});

test("upload and recording require a client session, and recording retains that session", async () => {
  const h = await fixture();
  const selected = h.input();
  const { sessionId: _sessionId, ...member } = selected;
  const source = {
    deviceId: "123",
    channel: "1",
    recordedAt: new Date().toISOString(),
  };
  try {
    for (const [path, query] of [
      ["/upload", new URLSearchParams(member)],
      ["/recording", new URLSearchParams({ ...member, ...source })],
    ] as const) {
      const response = await h.request(`${path}?${query.toString()}`, {
        method: "POST",
        body: "unused",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(h.extract).not.toHaveBeenCalled();

    const path = join(h.directory, "recording.webm");
    await runFfmpeg(
      "ffmpeg",
      [
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=96x192:r=1",
        "-t",
        "1.1",
        "-an",
        "-c:v",
        "libvpx",
        "-pix_fmt",
        "yuv420p",
        path,
      ],
      new AbortController().signal,
      64 * 1024,
    );
    const query = new URLSearchParams({ ...selected, ...source });
    const response = await h.request(`/recording?${query.toString()}`, {
      method: "POST",
      headers: { "content-type": "video/webm" },
      body: await readFile(path),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessionId: selected.sessionId,
      source: { ...source, channel: 1 },
    });
    expect(h.extract).toHaveBeenCalled();
    expect((await h.enrollment.poll(selected)).sessionId).toBe(
      selected.sessionId,
    );
    expect((await h.json("/cancel", selected)).status).toBe(200);
    expect((await h.json("/preview", selected)).status).toBe(410);
  } finally {
    await h.close();
  }
});
