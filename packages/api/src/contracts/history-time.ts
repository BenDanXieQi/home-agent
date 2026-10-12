import { z } from "zod";

export const deviceHistoryTimeSchema = z.iso
  .datetime()
  .refine((value) => !value.startsWith("0000-"), {
    message: "Use a PostgreSQL-compatible year",
  })
  .refine((value) => (value.match(/\.(\d+)Z$/)?.[1]?.length ?? 0) <= 6, {
    message: "Use at most microsecond precision",
  })
  .transform(
    (value) =>
      `${new Date(value).toISOString().slice(0, 19)}.${(value.match(/\.(\d+)Z$/)?.[1] ?? "").padEnd(6, "0")}Z`,
  );
