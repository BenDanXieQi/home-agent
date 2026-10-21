import { type identityClassSchema } from "../../household/identity/contracts";
import type { identityEvidenceSchema } from "./evidence";
import { createFaceModel } from "./face-model";
import { createPetModel } from "./pet-model";
import { createPersonAttributeModel } from "./person-attributes";
import { identityLimits } from "./config";
import { faceEngine } from "./processing-version";
import type { z } from "zod";
import type { identityRequestSchema } from "./protocol";

function adapter(
  load: () => Promise<
    | Awaited<ReturnType<typeof createFaceModel>>
    | Awaited<ReturnType<typeof createPetModel>>
    | Awaited<ReturnType<typeof createPersonAttributeModel>>
  >,
) {
  let model: Awaited<ReturnType<typeof load>> | undefined;
  let error: string | undefined;
  let retryAt = 0;
  async function reject(cause: unknown) {
    error = String(cause).slice(0, 4096);
    retryAt = performance.now() + identityLimits.restartDelayMs;
    console.error("Identity model adapter unavailable", cause);
    const previous = model;
    model = undefined;
    await previous?.close();
  }
  return {
    async prepare() {
      if (!model && performance.now() >= retryAt) {
        try {
          model = await load();
          error = undefined;
        } catch (cause) {
          await reject(cause);
        }
      }
      return { available: !!model, error };
    },
    async extract(request: z.infer<typeof identityRequestSchema>) {
      if (!model)
        return {
          kind: "unavailable" as const,
          error: error ?? "身份模型尚未准备",
        };
      try {
        return await model.extract(request);
      } catch (cause) {
        await reject(cause);
        return { kind: "unavailable" as const, error: error! };
      }
    },
    close: async () => {
      await model?.close();
      model = undefined;
    },
  };
}

export function createIdentityModel(directory: string) {
  const human = adapter(() => createFaceModel(directory));
  const pet = adapter(() => createPetModel(directory));
  const attributes = adapter(createPersonAttributeModel);
  function forClass(className: z.infer<typeof identityClassSchema>) {
    return className === "human" ? human : pet;
  }
  return {
    metadata: faceEngine,
    async prepare(
      classes: z.infer<typeof identityClassSchema>[],
      includeAttributes = false,
    ) {
      const statuses = new Map<
        typeof human,
        Awaited<ReturnType<typeof human.prepare>>
      >();
      const available: typeof classes = [];
      const failures = [];
      for (const className of new Set(classes)) {
        const selected = forClass(className);
        let status = statuses.get(selected);
        if (!status) {
          status = await selected.prepare();
          statuses.set(selected, status);
        }
        if (status.available) available.push(className);
        else
          failures.push({ className, error: status.error ?? "身份模型不可用" });
      }
      const attributeStatus = includeAttributes
        ? await attributes.prepare()
        : null;
      return {
        kind: "prepared" as const,
        available,
        failures,
        attributesAvailable: attributeStatus?.available ?? false,
        attributeError: attributeStatus?.error,
      };
    },
    async extract(request: z.infer<typeof identityRequestSchema>) {
      if (request.kind !== "tracking")
        return forClass(request.className).extract(request);
      const failures = [];
      const results: z.infer<typeof identityEvidenceSchema>[] = [];
      for (const selected of [human, pet]) {
        const tracks = request.tracks.filter(
          (track) => forClass(track.className) === selected,
        );
        if (!tracks.some((track) => request.targets.includes(track.trackId)))
          continue;
        const result = await selected.extract({ ...request, tracks });
        if (result.kind === "enrollment")
          throw new Error("Unexpected tracking enrollment result");
        if (result.kind === "result") results.push(result);
        else
          for (const className of new Set(
            tracks
              .filter((track) => request.targets.includes(track.trackId))
              .map((track) => track.className),
          )) {
            failures.push({ className, error: result.error });
          }
      }
      const attributeResult = request.attributeTargets?.length
        ? await attributes.extract({
            ...request,
            targets: request.attributeTargets,
          })
        : null;
      return {
        kind: "result" as const,
        failures,
        attributeError:
          attributeResult?.kind === "unavailable"
            ? attributeResult.error
            : undefined,
        samples: results.flatMap((result) => result.samples),
        attributes:
          attributeResult?.kind === "result" && "attributes" in attributeResult
            ? attributeResult.attributes
            : [],
        qualityRejected: results.reduce(
          (sum, result) => sum + result.qualityRejected,
          0,
        ),
      };
    },
    async close() {
      await Promise.all([human.close(), pet.close(), attributes.close()]);
    },
  };
}
