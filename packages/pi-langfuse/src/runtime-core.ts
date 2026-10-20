import type { TraceBackend } from "./tracing.js";

export interface LangfuseRuntime {
  readonly closed: boolean;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

type RuntimeSessionDisposer = (statusMessage: string) => void | Promise<void>;

export interface LangfuseRuntimeInternal extends LangfuseRuntime {
  readonly backend: TraceBackend;
  registerSession(disposer: RuntimeSessionDisposer): () => void;
}

const runtimes = new WeakMap<LangfuseRuntime, LangfuseRuntimeInternal>();

class ManagedLangfuseRuntime implements LangfuseRuntimeInternal {
  readonly backend;
  private state: "open" | "closing" | "closed" = "open";
  private readonly sessionDisposers = new Set<RuntimeSessionDisposer>();
  private flushQueue = Promise.resolve();
  private shutdownPromise: Promise<void> | undefined;

  constructor(backend: TraceBackend) {
    this.backend = backend;
  }

  get closed() {
    return this.state !== "open";
  }

  registerSession(disposer: RuntimeSessionDisposer) {
    if (this.state !== "open")
      throw new Error("Langfuse runtime is shutting down or already closed.");
    this.sessionDisposers.add(disposer);
    return () => {
      this.sessionDisposers.delete(disposer);
    };
  }

  flush() {
    if (this.state !== "open") {
      return Promise.reject(
        new Error("Langfuse runtime is shutting down or already closed."),
      );
    }
    const operation = this.flushQueue.then(() => this.backend.forceFlush());
    this.flushQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.state = "closing";
    this.shutdownPromise = Promise.resolve().then(() => this.shutdownNow());
    return this.shutdownPromise;
  }

  private async shutdownNow() {
    const errors: unknown[] = [];
    const disposers = Array.from(this.sessionDisposers);
    for (const dispose of disposers) {
      try {
        await dispose(
          "Langfuse runtime shut down before the tracing observer was disposed.",
        );
      } catch (error) {
        errors.push(error);
      }
    }
    this.sessionDisposers.clear();

    await this.flushQueue;
    try {
      await this.backend.forceFlush();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.backend.shutdown();
    } catch (error) {
      errors.push(error);
    } finally {
      this.state = "closed";
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "Langfuse runtime shutdown failed.");
  }
}

export function getLangfuseRuntimeInternal(runtime: LangfuseRuntime) {
  const internal = runtimes.get(runtime);
  if (!internal)
    throw new Error(
      "Tracing runtime was not created by @home-agent/pi-langfuse.",
    );
  return internal;
}

export function createLangfuseRuntimeFromBackend(backend: TraceBackend) {
  return registerLangfuseRuntime(new ManagedLangfuseRuntime(backend));
}

export function registerLangfuseRuntime(runtime: LangfuseRuntimeInternal) {
  runtimes.set(runtime, runtime);
  return runtime;
}
