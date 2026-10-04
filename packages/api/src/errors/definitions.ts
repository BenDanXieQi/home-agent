import type { ErrorCode } from "../contracts";
import { mijiaErrorDefinitions } from "../contracts/mijia-errors";

export const errorDefinitions = {
  ...mijiaErrorDefinitions,
  invalid_request: { status: 400, message: "The request is invalid." },
  invalid_json: { status: 400, message: "Provide a valid JSON body." },
  content_type_required: { status: 415, message: "Use application/json." },
  request_too_large: { status: 413, message: "The request body is too large." },
  local_access_required: {
    status: 403,
    message: "Use the local management interface.",
  },
  not_found: { status: 404, message: "The requested resource was not found." },
  internal_error: { status: 500, message: "An internal error occurred." },
  http_error: {
    status: 400,
    message: "The HTTP request could not be completed.",
  },
  connection_config_argument_invalid: {
    status: 400,
    message: "Specify --config once with a file path.",
  },
  connection_config_input_invalid: {
    status: 400,
    message: "Provide a complete, valid connection configuration.",
  },
  connection_config_invalid: {
    status: 503,
    message: "The connection configuration file is invalid.",
  },
  connection_config_unavailable: {
    status: 503,
    message: "The connection configuration file cannot be accessed.",
  },
  connection_config_read_only: {
    status: 403,
    message: "The connection configuration is read-only.",
  },
  connection_config_too_large: {
    status: 400,
    message: "The saved connection configuration would exceed the size limit.",
  },
  connection_config_save_failed: {
    status: 500,
    message: "The connection configuration could not be saved.",
  },
  agent_timeout: { status: 504, message: "The Agent request timed out." },
  agent_unavailable: {
    status: 502,
    message: "The Agent could not be reached.",
  },
  model_not_configured: {
    status: 503,
    message: "Configure AGENT_MODEL and OPENAI_API_KEY.",
  },
  database_not_configured: {
    status: 503,
    message: "Configure the Agent database and run db:migrate.",
  },
  persistence_unavailable: {
    status: 503,
    message: "Check the Agent database and run db:migrate.",
  },
  thread_incomplete: {
    status: 409,
    message:
      "This conversation has an unfinished run. Start a new conversation.",
  },
  thread_busy: {
    status: 409,
    message: "This conversation already has an active run.",
  },
  request_cancelled: { status: 408, message: "The request was cancelled." },
  run_timeout: { status: 504, message: "The Agent run timed out." },
  agent_execution_failed: { status: 500, message: "The Agent run failed." },
  perception_image_invalid: {
    status: 400,
    message: "Provide a valid image within the input limits.",
  },
  perception_busy: {
    status: 503,
    message: "Image analysis is busy. Try again shortly.",
  },
  perception_unavailable: {
    status: 503,
    message: "Image analysis is unavailable.",
  },
  perception_timeout: { status: 504, message: "Image analysis timed out." },
  perception_failed: { status: 500, message: "Image analysis failed." },
  perception_media_unavailable: {
    status: 410,
    message: "The window media is no longer available.",
  },
  perception_media_ineligible: {
    status: 409,
    message: "The window cannot produce the requested media.",
  },
  perception_media_not_ready: {
    status: 409,
    message: "The window media is not ready.",
  },
  perception_media_capacity: {
    status: 429,
    message: "Window media processing is at capacity. Try again shortly.",
  },
} as const satisfies Record<ErrorCode, { status: number; message: string }>;
