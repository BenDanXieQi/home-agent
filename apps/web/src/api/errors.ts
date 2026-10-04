import type { ApiError } from "@home-agent/api/contracts";
export type ClientErrorCode =
  | "network_error"
  | "request_timeout"
  | "request_cancelled"
  | "invalid_response"
  | "ice_gathering_timeout"
  | "missing_local_sdp";

export class RequestError extends Error {
  readonly details: ApiError | { code: ClientErrorCode };
  readonly status;

  constructor(
    details: ApiError | { code: ClientErrorCode },
    status?: Response["status"],
  ) {
    super("message" in details ? details.message : details.code);
    this.name = "RequestError";
    this.details = details;
    this.status = status;
  }
}
