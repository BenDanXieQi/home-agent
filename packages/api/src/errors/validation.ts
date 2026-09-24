import type { z } from "zod";
import type { ValidationIssue } from "../contracts";

// Expose field locations and safe constraints, never input values or library prose.
export function validationIssues(
  error: z.ZodError,
  rootPath = "request",
): ValidationIssue[] {
  return error.issues.map((issue): ValidationIssue => {
    const path = issue.path.map(String).join(".") || rootPath;
    switch (issue.code) {
      case "too_small":
        return {
          path,
          code: "too_small",
          params: { minimum: String(issue.minimum) },
        };
      case "too_big":
        return {
          path,
          code: "too_big",
          params: { maximum: String(issue.maximum) },
        };
      case "unrecognized_keys":
        return { path, code: "unknown_fields" };
      case "invalid_type":
        return { path, code: "invalid_type" };
      case "invalid_format":
        return { path, code: "invalid_format" };
      default:
        return { path, code: "invalid_value" };
    }
  });
}
