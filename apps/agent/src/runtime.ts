import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoize } from "es-toolkit";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  Harness,
  MemoryStorage,
  type Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createObservedHarnessOptions } from "@home-agent/observability/durable";
import type { initializeModelRuntime } from "./models";
import { createAgentHarness } from "./harness";
import { createPromptResolver } from "./prompts";

export async function createAgentRuntime({
  modelRuntime,
  extensions,
  promptConfiguration,
  openMainStorage,
  signal,
}: {
  modelRuntime: Awaited<ReturnType<typeof initializeModelRuntime>>;
  extensions: Parameters<typeof createObservedHarnessOptions>[0]["extensions"];
  promptConfiguration: Parameters<typeof createPromptResolver>[0];
  openMainStorage: () => Promise<Storage>;
  signal: AbortSignal;
}) {
  signal.throwIfAborted();

  await using resources = new AsyncDisposableStack();
  const prompts = resources.adopt(
    createPromptResolver(promptConfiguration),
    (instance) => instance.close(),
  );
  const workspacePath = resources.adopt(
    await mkdtemp(join(tmpdir(), "home-agent-")),
    (path) => rm(path, { recursive: true, force: true }),
  );
  const env = resources.adopt(
    new NodeExecutionEnv({ cwd: workspacePath }),
    (instance) => instance.cleanup(BACKGROUND_CONTEXT),
  );

  async function openHarness(storage: Storage) {
    resources.adopt(storage, (instance) => instance.close(BACKGROUND_CONTEXT));
    const { observationExtension, extensionRegistry, ...harnessOptions } =
      createObservedHarnessOptions({
        sourceModelCollection: modelRuntime.modelCollection,
        extensions,
      });
    const frameworkExtensions = [observationExtension];
    const piHarness = resources.adopt(
      await Harness.open(
        storage,
        {
          ...harnessOptions,
          env: () => env,
          onReport: (error) => {
            console.error("Agent runtime report:", error);
          },
          settings: {
            extensions: frameworkExtensions,
            stream: { maxRetries: 0 },
            retry: { enabled: false, maxRetries: 0 },
          },
        },
        withAbortSignal(signal, BACKGROUND_CONTEXT),
      ),
      (instance) => instance.close(BACKGROUND_CONTEXT),
    );
    return resources.use(
      createAgentHarness({
        harness: piHarness,
        frameworkExtensions,
        extensionRegistry,
        prompts,
      }),
    );
  }

  const harness = await openHarness(new MemoryStorage());
  const mainHarness = await openHarness(await openMainStorage());

  signal.throwIfAborted();

  const ownedResources = resources.move();
  const close = memoize(() => ownedResources.disposeAsync());

  return {
    workspacePath,
    harness,
    mainHarness,
    prompts,
    close,
    [Symbol.asyncDispose]: close,
  };
}
