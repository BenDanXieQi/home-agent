import { z } from "zod";
import type { MediaAnalysisInput } from "./analysis";

function entries<T extends z.ZodType>(schema: T) {
  return z
    .array(z.unknown())
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = schema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    )
    .catch([]);
}

const textSchema = z.coerce.string().catch("").default("");

export const perceptionAnalysisSchema = z.object({
  identities: entries(
    z.object({
      track_id: z
        .union([z.number(), z.string()])
        .pipe(z.coerce.number<string | number>().int()),
      name: z.preprocess(
        (value) => value ?? "unknown",
        z.coerce.string().catch("unknown"),
      ),
      confidence: z.coerce
        .number()
        .transform((value) => Math.max(0, Math.min(1, value)))
        .catch(0)
        .default(0),
      reason: textSchema,
    }),
  ),
  pet_identities: entries(
    z.object({
      name: textSchema.transform((value) => value.trim().slice(0, 32)),
      conf: textSchema.transform((value) =>
        value.trim().toLowerCase() === "high"
          ? ("high" as const)
          : ("mid" as const),
      ),
      reason: textSchema,
    }),
  ),
  caption: z.string().catch("").default(""),
  speeches: entries(
    z.object({
      speaker: textSchema,
      content: textSchema,
      is_complete: z.coerce.boolean().default(true),
      needs_response: z.coerce.boolean().default(false),
    }),
  ),
  env_sounds: z.string().catch("").default(""),
  matched_rules: entries(
    z.object({
      rule_name: textSchema,
      reason: textSchema,
      hit: z
        .union([z.boolean(), z.string()])
        .transform(
          (value) =>
            value !== false &&
            !(
              typeof value === "string" &&
              ["false", "0", "no"].includes(value.trim().toLowerCase())
            ),
        ),
    }),
  ),
  suggestions: entries(
    z.object({
      event: textSchema,
      action: textSchema,
      urgency: z
        .enum(["high", "medium", "low", "ignore"])
        .catch("low")
        .default("low"),
    }),
  ),
});

function parseJsonObject(text: string) {
  try {
    const value: unknown = JSON.parse(text);
    const parsed = z.record(z.string(), z.unknown()).safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function findJsonObject(text: string) {
  const lastClose = text.lastIndexOf("}");
  let best: ReturnType<typeof parseJsonObject>;
  for (let index = lastClose; index >= 0; index--) {
    if (text[index] !== "{") continue;

    const parsed = parseJsonObject(text.slice(index, lastClose + 1));
    if (parsed) best = parsed;
    else if (best) break;
  }
  return best;
}

function extractJsonObject(text: string) {
  const cleaned =
    text
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/^[\s\S]*?<\/think>/, "")
      .trim() || text.trim();
  const blocks = [...cleaned.matchAll(/```(?:\w*)?\s*\n?([\s\S]*?)\n?```/g)];
  for (const block of blocks.toReversed()) {
    const parsed = findJsonObject(block[1] ?? "");
    if (parsed) return parsed;
  }
  return findJsonObject(cleaned);
}

export function parseMediaAnalysis(text: string, input: MediaAnalysisInput) {
  const object = extractJsonObject(text);
  const parsed = perceptionAnalysisSchema.parse(object ?? {});
  if (!object)
    console.error("Media analysis: no valid JSON object in model response");

  const petNames = (confidence: "high" | "mid") =>
    [
      ...new Set(
        parsed.pet_identities
          .filter((entry) => entry.conf === confidence && entry.name)
          .map((entry) => entry.name.replace(/\s+/g, " ").trim().slice(0, 40)),
      ),
    ].toSorted();
  const petHigh = petNames("high");
  const petMid = petNames("mid");
  if (petHigh.length || petMid.length)
    console.info("Media analysis: pet_identities", {
      high: petHigh,
      mid: petMid,
    });

  const identity = input.identity;
  const gallery = identity?.matchDisabled ? [] : (identity?.gallery ?? []);
  const nameToPersonId = new Map<string, string>();
  const roleCounts = new Map<string, number>();
  for (const entry of gallery) {
    nameToPersonId.set(entry.personId.toLowerCase(), entry.personId);
    nameToPersonId.set(entry.label.trim().toLowerCase(), entry.personId);
    if (entry.role) {
      const role = entry.role.trim().toLowerCase();
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    }
  }
  for (const entry of gallery) {
    const role = entry.role?.trim().toLowerCase();
    if (role && roleCounts.get(role) === 1)
      nameToPersonId.set(role, entry.personId);
  }

  const trackIds = new Set(
    identity?.candidates?.map((candidate) => candidate.trackId) ?? [],
  );
  const confidenceCutoff = identity?.confidenceCutoff ?? 0.5;
  const identities = parsed.identities
    .filter((entry) => trackIds.has(entry.track_id))
    .map((entry) => {
      const name = entry.name.trim() || "unknown";
      const lowerName = name.toLowerCase();
      const numberedUnknown =
        lowerName.startsWith("unknown_") || lowerName.startsWith("unknown-");
      const noPerson = lowerName
        .replace(/[\s-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .startsWith("no_person");
      const personId =
        noPerson || lowerName === "unknown" || numberedUnknown
          ? undefined
          : (nameToPersonId.get(lowerName) ??
            nameToPersonId.get(
              name
                .replace(/[（(].*$/, "")
                .trim()
                .toLowerCase(),
            ));

      return {
        track_id: entry.track_id,
        person_id:
          entry.confidence >= confidenceCutoff
            ? (personId ?? "unknown")
            : "unknown",
        confidence: entry.confidence,
        reason: entry.reason.slice(0, 50),
        raw_name: numberedUnknown && !identity?.distinguish ? "unknown" : name,
        no_person: noPerson,
      };
    });

  const ruleNameToId = new Map(
    input.context?.rules?.map((rule) => [rule.name, rule.id]) ?? [],
  );
  const matchedRules = parsed.matched_rules.flatMap((entry) => {
    const ruleId =
      ruleNameToId.get(entry.rule_name) ??
      [...ruleNameToId].find(
        ([name]) =>
          name &&
          entry.rule_name &&
          (name.includes(entry.rule_name) || entry.rule_name.includes(name)),
      )?.[1];
    return entry.hit && ruleId !== undefined
      ? [
          {
            rule_id: ruleId,
            rule_name: entry.rule_name,
            reason: entry.reason,
          },
        ]
      : [];
  });
  const caption = parsed.caption.trim();
  const envSounds = parsed.env_sounds.trim();

  return {
    skipped: !object,
    identities,
    caption: !object
      ? [{ description: "[解析失败] No valid JSON object in model response" }]
      : caption
        ? [{ description: caption }]
        : [],
    speeches: parsed.speeches,
    env_sounds: envSounds ? [envSounds] : [],
    matched_rules: matchedRules,
    suggestions: parsed.suggestions.flatMap(({ urgency, ...entry }) =>
      urgency === "ignore" ? [] : [{ ...entry, urgency }],
    ),
  };
}
