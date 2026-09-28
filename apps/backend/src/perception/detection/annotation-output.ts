import { randomUUID } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ImageProcessingError } from "./image-request";

// Only optional annotated PNG exports use this protocol; detection observations
// and domain state do not acquire file reservations.
// The parent owns output reservations and publication. A worker may write only
// the reserved staging path; a retired worker cannot revoke an accepted commit.
const reserved = new Map<string, ReturnType<typeof createOutput>>();

function createOutput(scope: object, owner: object, outputPath: string) {
  const stagingPath = join(
    dirname(outputPath),
    `.perception-${randomUUID()}.tmp.png`,
  );
  let state: "writing" | "committing" | "blocked" | "settled" = "writing";
  let accepted = false;
  let publicationError: ImageProcessingError | undefined;
  let cleaning: Promise<void> | undefined;

  function release() {
    state = "settled";
    reserved.delete(outputPath);
  }

  function discard() {
    if (state === "settled") return Promise.resolve();
    if (state === "committing")
      throw new Error("Cannot discard an annotation being committed");
    if (cleaning) return cleaning;
    state = "blocked";
    cleaning = (async () => {
      try {
        await unlink(stagingPath);
      } catch (cause) {
        if (
          !(
            cause instanceof Error &&
            "code" in cause &&
            (cause.code === "ENOENT" ||
              cause.code === "ENOTDIR" ||
              cause.code === "ENAMETOOLONG")
          )
        )
          throw new Error(`Unable to remove staged image: ${stagingPath}`, {
            cause,
          });
      }
      release();
    })().finally(() => {
      cleaning = undefined;
    });
    return cleaning;
  }

  function writerFailed() {
    if (state !== "writing")
      throw new Error("Annotation writer no longer owns this output");
    // ImageProcessingError confirms that writing never started or its partial
    // output was removed. Unknown writer failures must instead call discard().
    release();
  }

  function commit() {
    if (state !== "writing")
      throw new Error("Annotation is not awaiting acceptance");
    accepted = true;
    state = "committing";
    const started = performance.now();
    return (async () => {
      try {
        await rename(stagingPath, outputPath);
      } catch (cause) {
        publicationError = new ImageProcessingError(
          "output_failed",
          `Cannot publish annotated image: ${outputPath}`,
          { cause },
        );
        state = "blocked";
        await discard();
        throw publicationError;
      }
      const commitMs = performance.now() - started;
      release();
      return commitMs;
    })();
  }

  return {
    scope,
    owner,
    outputPath,
    stagingPath,
    commit,
    discard,
    writerFailed,
    get state() {
      return state;
    },
    get accepted() {
      return accepted;
    },
    get publicationError() {
      return publicationError;
    },
  };
}

export function createAnnotationOutputs() {
  if (reserved.size > 0)
    throw new Error(
      "Pending annotated image outputs still belong to an existing detection pool",
    );
  const scope = {};

  function reserve(owner: object, outputPath: string) {
    if (reserved.has(outputPath)) return undefined;
    const output = createOutput(scope, owner, outputPath);
    reserved.set(outputPath, output);
    return output;
  }

  function retire(owner: object) {
    return Promise.all(
      [...reserved.values()]
        .filter(
          (output) =>
            output.scope === scope &&
            output.owner === owner &&
            output.state !== "committing",
        )
        .map((output) => output.discard()),
    );
  }

  function discardStoppedOutputs() {
    return Promise.all(
      [...reserved.values()]
        .filter(
          (output) => output.scope === scope && output.state !== "committing",
        )
        .map((output) => output.discard()),
    );
  }

  function committingPaths() {
    return [...reserved.values()]
      .filter(
        (output) => output.scope === scope && output.state === "committing",
      )
      .map((output) => output.outputPath);
  }

  return { reserve, retire, discardStoppedOutputs, committingPaths };
}
