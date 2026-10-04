import type { z } from "zod";
import type { memberProfileSchema } from "@home-agent/api/household-members";

export function identityClassForSubject(
  kind: z.infer<typeof memberProfileSchema>["kind"],
  species: unknown,
) {
  if (kind === "person") return "human" as const;
  const value = typeof species === "string" ? species.trim().toLowerCase() : "";
  if (["cat", "猫"].includes(value)) return "cat" as const;
  if (["dog", "狗", "犬"].includes(value)) return "dog" as const;
  return null;
}
