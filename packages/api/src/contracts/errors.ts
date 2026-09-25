import { z } from "zod";
import { mijiaErrorCodes } from "./mijia-errors";

export const errorCodeSchema = z.enum([
  ...mijiaErrorCodes,
  "invalid_request",
  "invalid_json",
  "content_type_required",
  "request_too_large",
  "local_access_required",
  "not_found",
  "internal_error",
  "http_error",
  "connection_config_argument_invalid",
  "connection_config_input_invalid",
  "connection_config_invalid",
  "connection_config_unavailable",
  "connection_config_read_only",
  "connection_config_too_large",
  "connection_config_save_failed",
  "agent_timeout",
  "agent_unavailable",
  "model_not_configured",
  "database_not_configured",
  "persistence_unavailable",
  "thread_busy",
  "request_cancelled",
  "run_timeout",
  "agent_execution_failed",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const messageParamsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number()]),
);
export const validationIssueCodeSchema = z.enum([
  "invalid_type",
  "invalid_format",
  "invalid_value",
  "too_small",
  "too_big",
  "unknown_fields",
  "invalid_service_url",
  "invalid_yaml",
  "file_too_large",
  "not_regular_file",
]);
export const validationIssueSchema = z.object({
  path: z.string(),
  code: validationIssueCodeSchema,
  params: messageParamsSchema.optional(),
});
export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  params: messageParamsSchema.optional(),
  issues: z.array(validationIssueSchema).optional(),
  traceId: z.string().optional(),
});
export const runFailedEventSchema = z.object({
  runId: z.uuid(),
  threadId: z.uuid(),
  error: apiErrorSchema,
});
export type MessageParams = z.infer<typeof messageParamsSchema>;
export type ValidationIssue = z.infer<typeof validationIssueSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type RunFailedEvent = z.infer<typeof runFailedEventSchema>;
