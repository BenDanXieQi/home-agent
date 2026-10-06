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
  household_scope_changed: {
    status: 409,
    message: "The household scope has changed. Reload its data.",
  },
  household_unavailable: {
    status: 503,
    message: "The household is unavailable.",
  },
  household_capacity_exceeded: {
    status: 503,
    message: "The household request exceeds its resource budget.",
  },
  household_storage_unavailable: {
    status: 503,
    message: "Household storage is unavailable.",
  },
  device_history_export_too_large: {
    status: 413,
    message:
      "The device history export exceeds its size limit. Narrow the time range or device selection.",
  },
  spatial_record_changed: {
    status: 409,
    message: "The spatial record has changed. Reload before editing.",
  },
  spatial_scope_changed: {
    status: 409,
    message: "The household binding has changed. Reload spatial data.",
  },
  spatial_record_exists: {
    status: 409,
    message: "The spatial record already exists.",
  },
  spatial_reference_invalid: {
    status: 400,
    message: "Select existing, valid spatial references.",
  },
  spatial_source_invalid: {
    status: 400,
    message: "Select a device and channel from the current inventory.",
  },
  spatial_storage_unavailable: {
    status: 503,
    message:
      "Spatial storage is unavailable. Reload to confirm the saved state before retrying a write.",
  },
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
  request_cancelled: { status: 408, message: "The request was cancelled." },
  run_timeout: { status: 504, message: "The Agent run timed out." },
  agent_execution_failed: { status: 500, message: "The Agent run failed." },
  identity_enrollment_unavailable: {
    status: 410,
    message: "The enrollment expired or is no longer available.",
  },
  identity_reference_unavailable: {
    status: 409,
    message: "The person or reference is no longer available.",
  },
  identity_recording_invalid: {
    status: 400,
    message: "The recorded video cannot be decoded within the input limits.",
  },
  identity_source_unavailable: {
    status: 409,
    message: "The selected camera is no longer available in this household.",
  },
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
