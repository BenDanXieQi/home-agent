export type MiCloudErrorCode =
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
  constructor(readonly code: MiCloudErrorCode) {
    super(`MiCloud: ${code}`);
    this.name = "MiCloudError";
  }
}
