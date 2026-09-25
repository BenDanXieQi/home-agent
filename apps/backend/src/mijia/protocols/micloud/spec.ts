import { z } from "zod";
import {
  readLimitedJson,
  ResponseBodyError,
} from "@home-agent/api/http/read-body";
import type { MijiaCapability, MijiaDeviceSpec } from "@home-agent/api/mijia";
import { MiCloudError } from "./errors";
import type { MiCloudDevice } from "./client";

const iid = z.number().int().positive();
const urn = z.string().regex(/^urn:[^:]+:device:[^:]+:.+$/);
const base = { iid, type: z.string(), description: z.string() };
const propertySchema = z.object({
  ...base,
  format: z.string(),
  access: z.array(z.string()),
  unit: z.string().optional(),
  "value-range": z.tuple([z.number(), z.number(), z.number()]).optional(),
  "value-list": z
    .array(
      z.object({
        value: z.union([z.number(), z.string(), z.boolean()]),
        description: z.string(),
      }),
    )
    .optional(),
});
const instanceSchema = z.object({
  type: urn,
  description: z.string(),
  services: z.array(
    z.object({
      ...base,
      properties: z.array(propertySchema).optional(),
      actions: z
        .array(z.object({ ...base, in: z.array(iid), out: z.array(iid) }))
        .optional(),
      events: z
        .array(z.object({ ...base, arguments: z.array(iid) }))
        .optional(),
    }),
  ),
});
const translationsSchema = z.object({
  data: z.record(z.string(), z.record(z.string(), z.string().nullable())),
});
type Spec = Pick<MijiaDeviceSpec, "category" | "spec">;
type Instance = z.infer<typeof instanceSchema>;
type Translations = z.infer<typeof translationsSchema>["data"][string];
const CACHE_TTL_MS = 24 * 60 * 60_000;
const CACHE_LIMIT = 128;

function typeName(type: string) {
  const name = type.split(":")[3];
  if (!name) throw new MiCloudError("spec-invalid-response");
  return name;
}

/** Public metadata only. This client never receives account cookies or tokens. */
export class MiotSpecClient {
  private readonly models = new Map<
    string,
    { urn: string; expiresAt: number }
  >();
  private readonly instances = new Map<
    string,
    { instance: Instance; expiresAt: number }
  >();
  private readonly translations = new Map<
    string,
    { values: Translations; expiresAt: number }
  >();

  async get(device: MiCloudDevice, parentSignal: AbortSignal) {
    const requestSignal = AbortSignal.any([
      parentSignal,
      AbortSignal.timeout(30_000),
    ]);
    this.assertActive(requestSignal);
    const model = typeof device.model === "string" ? device.model : "";
    let deviceUrn: string;
    if (typeof device.spec_type === "string" && device.spec_type.length > 0) {
      const parsed = urn.safeParse(device.spec_type);
      if (!parsed.success) throw new MiCloudError("spec-invalid-response");
      deviceUrn = parsed.data;
    } else {
      if (!model) throw new MiCloudError("spec-unavailable");
      const cached = this.models.get(model);
      if (cached && cached.expiresAt > Date.now()) deviceUrn = cached.urn;
      else {
        const result = z
          .object({ urn: urn.nullish() })
          .safeParse(
            await this.request(
              "/internal/urn-by-model-version",
              { model, version: "0" },
              requestSignal,
            ),
          );
        if (!result.success) throw new MiCloudError("spec-invalid-response");
        if (!result.data.urn) throw new MiCloudError("spec-unavailable");
        deviceUrn = result.data.urn;
        this.limit(this.models);
        this.models.set(model, {
          urn: deviceUrn,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
      }
    }
    const cached = this.instances.get(deviceUrn);
    let instance: Instance;
    if (cached && cached.expiresAt > Date.now()) instance = cached.instance;
    else {
      const parsed = instanceSchema.safeParse(
        await this.request(
          "/miot-spec-v2/instance",
          { type: deviceUrn },
          requestSignal,
        ),
      );
      if (!parsed.success) throw new MiCloudError("spec-invalid-response");
      instance = parsed.data;
      // Validate structural relationships before caching capabilities. Display
      // translations are optional and cannot turn readable properties into an empty spec.
      parseSpec(instance, {});
      this.assertActive(requestSignal);
      this.limit(this.instances);
      this.instances.set(deviceUrn, {
        instance,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }
    const translations = await this.getTranslations(
      deviceUrn,
      requestSignal,
      parentSignal,
    );
    // Once capabilities are available, exhausting the optional translation's
    // network budget must not discard them. The caller's lifetime still applies.
    this.assertActive(parentSignal);
    return {
      did: device.did,
      name: device.name ?? "",
      home: device.home_name ?? "",
      model,
      room: device.room_name ?? "",
      online: device.isOnline === true,
      ...structuredClone(parseSpec(instance, translations)),
    };
  }

  private async getTranslations(
    deviceUrn: string,
    requestSignal: AbortSignal,
    parentSignal: AbortSignal,
  ) {
    this.assertActive(parentSignal);
    const cached = this.translations.get(deviceUrn);
    if (cached && cached.expiresAt > Date.now()) return cached.values;
    // Translations consume only the remaining metadata budget; no fresh timeout
    // or detached background request is started after that budget expires.
    if (requestSignal.aborted) return {};
    try {
      const parsed = translationsSchema.safeParse(
        await this.request(
          "/instance/v2/multiLanguage",
          { urn: deviceUrn },
          requestSignal,
        ),
      );
      this.assertActive(parentSignal);
      if (requestSignal.aborted || !parsed.success) return {};
      const values = parsed.data.data["zh_cn"] ?? {};
      this.limit(this.translations);
      this.translations.set(deviceUrn, {
        values,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return values;
    } catch (error) {
      // Parent cancellation, account revocation and caller deadlines remain
      // terminal; only the optional request's own failure is isolated.
      this.assertActive(parentSignal);
      if (!(error instanceof MiCloudError)) throw error;
      // Keep failed translations out of the cache so a later query can recover
      // without re-fetching the already validated capability instance.
      return {};
    }
  }

  private limit(map: Map<string, unknown>) {
    if (map.size >= CACHE_LIMIT) {
      const first = map.keys().next().value;
      if (first !== undefined) map.delete(first);
    }
  }

  private assertActive(signal: AbortSignal) {
    if (signal.aborted)
      throw new MiCloudError(
        signal.reason instanceof DOMException &&
          signal.reason.name === "TimeoutError"
          ? "timeout"
          : "cancelled",
      );
  }

  private async request(
    path: string,
    params: Record<string, string>,
    signal: AbortSignal,
  ) {
    const url = new URL(path, "https://miot-spec.org");
    url.search = new URLSearchParams(params).toString();
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        signal,
        redirect: "error",
        credentials: "omit",
      });
      if (response.status === 404) throw new MiCloudError("spec-unavailable");
      if (!response.ok) throw new MiCloudError("spec-failed");
      return await readLimitedJson(response, 4 * 1024 * 1024, signal);
    } catch (error) {
      this.assertActive(signal);
      if (error instanceof MiCloudError) throw error;
      throw new MiCloudError(
        error instanceof ResponseBodyError
          ? "spec-invalid-response"
          : "spec-failed",
      );
    } finally {
      await response?.body?.cancel().catch(() => {});
    }
  }
}

const pad = (value: number) => String(value).padStart(3, "0");

function parseSpec(instance: Instance, translations: Translations) {
  const result: Spec = { category: typeName(instance.type), spec: {} };
  const translate = (key: string, description: string) =>
    translations[key]?.trim() || description;
  const add = (key: string, capability: MijiaCapability) => {
    if (Object.hasOwn(result.spec, key))
      throw new MiCloudError("spec-invalid-response");
    result.spec[key] = capability;
  };
  for (const service of instance.services) {
    if (
      !service.type.startsWith("urn:miot-spec-v2:") ||
      typeName(service.type) === "device-information"
    )
      continue;
    const prefix = `service:${pad(service.iid)}`;
    const serviceDescription = translate(prefix, service.description);
    const common = {
      service_type_name: typeName(service.type),
      service_description: serviceDescription,
    };
    const description = (key: string, original: string) => {
      const text = translate(key, original);
      return text === serviceDescription
        ? text
        : `${serviceDescription} ${text}`;
    };
    const properties = new Map(
      (service.properties ?? []).map((property) => [property.iid, property]),
    );
    if (properties.size !== (service.properties ?? []).length)
      throw new MiCloudError("spec-invalid-response");
    for (const property of properties.values()) {
      if (!property.type.startsWith("urn:miot-spec-v2:")) continue;
      const key = `${prefix}:property:${pad(property.iid)}`;
      add(`prop.${service.iid}.${property.iid}`, {
        ...common,
        description: description(key, property.description),
        format: property.format,
        writeable: property.access.includes("write"),
        readable: property.access.includes("read"),
        notify: property.access.includes("notify"),
        type_name: typeName(property.type),
        ...(property.description
          ? { prop_description: property.description }
          : {}),
        ...(property.unit ? { unit: property.unit } : {}),
        ...(property["value-range"]
          ? { value_range: property["value-range"] }
          : {}),
        ...(property["value-list"]?.length
          ? {
              value_list: property["value-list"].map((value, index) => ({
                value: value.value,
                name: value.description,
                description: translate(
                  `${key}:valuelist:${pad(index)}`,
                  value.description,
                ),
              })),
            }
          : {}),
      });
    }
    for (const action of service.actions ?? []) {
      if (!action.type.startsWith("urn:miot-spec-v2:")) continue;
      const inputs = action.in.map((id) => {
        const property = properties.get(id);
        if (!property) throw new MiCloudError("spec-invalid-response");
        return property;
      });
      const descriptions = inputs.map(
        (property) =>
          `${translate(`${prefix}:property:${pad(property.iid)}`, property.description)}: ${property.format}`,
      );
      add(`action.${service.iid}.${action.iid}`, {
        ...common,
        description: description(
          `${prefix}:action:${pad(action.iid)}`,
          action.description,
        ),
        format: `[${descriptions.map((value) => JSON.stringify(value)).join(", ")}]`,
        writeable: true,
        readable: false,
        notify: false,
        type_name: typeName(action.type),
        ...(action.description ? { prop_description: action.description } : {}),
        ...(inputs.length
          ? {
              in_params: inputs.map((property) => ({
                name: typeName(property.type),
                format: property.format,
              })),
            }
          : {}),
      });
    }
  }
  return result;
}
