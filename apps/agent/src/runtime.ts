import {
  ChordError,
  local,
  opaque,
  resource,
  type Host,
} from "@earendil-works/chord";
import { Type } from "typebox";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoize } from "es-toolkit";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createObservedHarnessOptions } from "@home-agent/observability/durable";
import { AgentModels, type initializeModelRuntime } from "./models";
import { createAgentHarness } from "./harness";
import { createPromptResolver } from "./prompts";

export function getServiceInstance<T>(service: {
  readonly instance: T | undefined;
  readonly contract: { readonly name: string };
}) {
  const instance = service.instance;
  if (instance === undefined)
    throw new ChordError(
      "not_ready",
      `Service ${service.contract.name} is not ready`,
    );

  return instance;
}

async function createAgentRuntime({
  modelRuntime,
  extensions,
  promptConfiguration,
  signal,
}: {
  modelRuntime: Awaited<ReturnType<typeof initializeModelRuntime>>;
  extensions: Parameters<typeof createObservedHarnessOptions>[0]["extensions"];
  promptConfiguration: Parameters<typeof createPromptResolver>[0];
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

  const { observationExtension, extensionRegistry, ...harnessOptions } =
    createObservedHarnessOptions({
      sourceModelCollection: modelRuntime.modelCollection,
      extensions,
    });
  const frameworkExtensions = [observationExtension];
  const piHarness = resources.adopt(
    await Harness.open(
      new MemoryStorage(),
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

  const harness = resources.use(
    createAgentHarness({
      harness: piHarness,
      frameworkExtensions,
      extensionRegistry,
      prompts,
    }),
  );

  signal.throwIfAborted();

  const ownedResources = resources.move();
  const close = memoize(() => ownedResources.disposeAsync());

  return {
    workspacePath,
    harness,
    prompts,
    close,
    [Symbol.asyncDispose]: close,
  };
}

export const AgentRuntime = local("home.agent.runtime", {
  version: 1,
  input: Type.Object({}),
  members: {
    instance: opaque<Awaited<ReturnType<typeof createAgentRuntime>>>(
      "home.agent.runtime@1",
    ),
  },
});

export function registerAgentRuntime(
  host: Host,
  options: Omit<Parameters<typeof createAgentRuntime>[0], "modelRuntime">,
) {
  host.serve(
    AgentRuntime,
    (_input, _principal, self) => {
      const modelsHandle = self.get(AgentModels, {});

      const resources = self.resources({
        runtime: resource({
          rev: 1,
          deps: [modelsHandle],
          open: ({ signal }) =>
            createAgentRuntime({
              ...options,
              modelRuntime: getServiceInstance(modelsHandle),
              signal: AbortSignal.any([signal, options.signal]),
            }),
          close: (runtime) => runtime.close(),
        }),
      });

      return { instance: self.expose(resources.runtime) };
    },
    { eager: true },
  );
}
