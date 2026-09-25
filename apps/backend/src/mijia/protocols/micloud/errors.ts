export type MiCloudErrorCode =
  | "invalid-input"
  | "spec-unavailable"
  | "spec-invalid-response"
  | "spec-failed"
  | "network"
  | "timeout"
  | "cancelled"
  | "expired"
  | "invalid-response"
  | "missing-credentials"
  | "authentication"
  | "security-required"
  | "security-code-invalid"
  | "unsupported-security"
  | "invalid-session"
  | "invalid-state"
  | "unsupported-region";

/** Static messages only: upstream bodies, headers, URLs and causes are never retained. */
export class MiCloudError extends Error {
  readonly httpStatus: number | undefined;
  readonly upstreamCode: number | undefined;
  readonly retryAfterAt: number | undefined;

  constructor(
    readonly code: MiCloudErrorCode,
    details: {
      httpStatus?: number;
      upstreamCode?: number;
      retryAfterAt?: number;
    } = {},
  ) {
    super(`MiCloud: ${code}`);
    this.name = "MiCloudError";
    this.httpStatus = details.httpStatus;
    this.upstreamCode = details.upstreamCode;
    this.retryAfterAt = details.retryAfterAt;
  }
}
