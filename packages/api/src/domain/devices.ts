import { z } from "zod";

export const deviceValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
]);

export const inventoryDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string(),
  home_id: z.string().nullable(),
  home_name: z.string().nullable(),
  room_id: z.string().nullable(),
  room_name: z.string().nullable(),
  online: z.boolean(),
  camera: z.boolean(),
  channels: z.array(z.union([z.literal(1), z.literal(2)])),
});
const capabilityValueShape = {
  format: z.string(),
  unit: z.string().optional(),
  value_range: z.tuple([z.number(), z.number(), z.number()]).optional(),
  value_list: z
    .array(
      z.object({
        value: deviceValueSchema,
        name: z.string(),
        description: z.string(),
      }),
    )
    .optional(),
};

export const deviceCapabilitySchema = z.object({
  description: z.string(),
  ...capabilityValueShape,
  writeable: z.boolean(),
  readable: z.boolean(),
  notify: z.boolean(),
  type_name: z.string().optional(),
  service_type_name: z.string().optional(),
  service_description: z.string().optional(),
  in_params: z
    .array(
      z.object({
        piid: z.number().int().positive(),
        name: z.string(),
        ...capabilityValueShape,
      }),
    )
    .optional(),
  prop_description: z.string().optional(),
});

export function deviceRoomKey(
  device: Pick<z.infer<typeof inventoryDeviceSchema>, "home_id" | "room_id">,
) {
  return JSON.stringify([device.home_id, device.room_id]);
}

function numberFormat(format: string) {
  const normalized = format.toLowerCase();
  if (["float", "double", "number"].includes(normalized)) {
    return {
      integer: false,
      minimum: -Number.MAX_VALUE,
      maximum: Number.MAX_VALUE,
    };
  }
  const match = /^(u?)int(8|16|32|64)?$/.exec(normalized);
  if (!match) return null;
  const bits = Number(match[2] ?? 32);
  return {
    integer: true,
    minimum:
      match[1] === "u"
        ? 0
        : Math.max(Number.MIN_SAFE_INTEGER, -(2 ** (bits - 1))),
    maximum: Math.min(
      Number.MAX_SAFE_INTEGER,
      2 ** (bits - (match[1] === "u" ? 0 : 1)) - 1,
    ),
  };
}

/** Checks device command values, including discrete numeric steps. Null means valid. */
export function validateDeviceValue(
  capability: Pick<
    z.infer<typeof deviceCapabilitySchema>,
    "format" | "value_list" | "value_range"
  >,
  value: z.infer<typeof deviceValueSchema>,
) {
  if (
    capability.value_list?.length &&
    !capability.value_list.some((item) => item.value === value)
  ) {
    return "值不在设备允许的枚举选项中";
  }
  const format = capability.format.toLowerCase();
  const numeric = numberFormat(format);
  if (format === "bool" || format === "boolean") {
    if (typeof value !== "boolean") return "设备属性需要布尔值";
  } else if (format === "string") {
    if (typeof value !== "string") return "设备属性需要文本值";
  } else if (numeric) {
    if (typeof value !== "number" || !Number.isFinite(value))
      return "设备属性需要有限数值";
    if (numeric.integer && !Number.isSafeInteger(value))
      return "设备属性需要安全范围内的整数";
    if (value < numeric.minimum || value > numeric.maximum)
      return "数值超出属性格式允许的范围";
    if (capability.value_range) {
      const [minimum, maximum, step] = capability.value_range;
      if (
        ![minimum, maximum, step].every(Number.isFinite) ||
        minimum > maximum ||
        step <= 0
      )
        return "设备规格的数值范围无效";
      if (value < minimum || value > maximum) return "数值超出设备允许的范围";
      const count = (value - minimum) / step;
      if (
        Math.abs(count - Math.round(count)) >
        Math.max(1e-8, Math.abs(count) * Number.EPSILON * 4)
      )
        return "数值不符合设备要求的步长";
    }
  } else if (!capability.value_list?.length) {
    return "不支持此设备属性格式";
  }
  return null;
}

export function deriveDeviceValue(
  capability: Pick<
    z.infer<typeof deviceCapabilitySchema>,
    "format" | "unit" | "value_list" | "value_range"
  >,
) {
  const format = capability.format.toLowerCase();
  const kind = capability.value_list?.length
    ? "enum"
    : format === "bool" || format === "boolean"
      ? "boolean"
      : numberFormat(format)
        ? "number"
        : format === "string"
          ? "text"
          : null;
  if (!kind) return null;
  return {
    kind,
    format: capability.format,
    options: (capability.value_list ?? []).map((item) => ({
      value: item.value,
      label: item.description || item.name || String(item.value),
    })),
    unit: capability.unit ?? null,
    range: capability.value_range ?? null,
  } as const;
}
