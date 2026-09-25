import type { z } from "zod";
import type { ValidationIssue } from "../contracts";

// Expose field locations and safe constraints, never input values or library prose.
export function validationIssues(error: z.ZodError, rootPath = "request") {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".") || rootPath;
    switch (issue.code) {
      case "too_small":
        return {
          path,
          code: "too_small",
          params: { minimum: String(issue.minimum) },
        } satisfies ValidationIssue;
      case "too_big":
        return {
          path,
          code: "too_big",
          params: { maximum: String(issue.maximum) },
        } satisfies ValidationIssue;
      case "unrecognized_keys":
        return { path, code: "unknown_fields" } satisfies ValidationIssue;
      case "invalid_type":
        return { path, code: "invalid_type" } satisfies ValidationIssue;
      case "invalid_format":
        return { path, code: "invalid_format" } satisfies ValidationIssue;
      default:
        return { path, code: "invalid_value" } satisfies ValidationIssue;
    }
  });
}
