import { AppError, errorPayload } from "@home-agent/api/errors";
import { MiCloudError, type MiCloudErrorCode } from "./micloud";
import {
  isMijiaFailureReason,
  type MijiaErrorCode,
  type MijiaErrorDetails,
  type MijiaFailureReason,
} from "@home-agent/api/mijia";
import { CredentialStoreError } from "../credentials/store";
import { Go2RtcError } from "./go2rtc-adapter";

// Translate provider vocabulary at the integration boundary. The public API
// uses snake_case and distinguishes cloud responses from camera-service responses.
const miCloudReasons = {
  network: "network",
  timeout: "timeout",
  cancelled: "cancelled",
  expired: "expired",
  "invalid-response": "cloud_invalid_response",
  "missing-credentials": "missing_credentials",
  authentication: "authentication",
  "security-required": "security_required",
  "security-code-invalid": "security_code_invalid",
  "unsupported-security": "unsupported_security",
  "invalid-session": "credential_storage",
  "invalid-state": "invalid_state",
  "unsupported-region": "unsupported_region",
} satisfies Record<MiCloudErrorCode, MijiaFailureReason>;

export class MijiaError extends AppError {
  declare readonly code: MijiaErrorCode;
  constructor(readonly reason: MijiaFailureReason) {
    super(`mijia_${reason}`);
    this.name = "MijiaError";
  }

  toPayload() {
    return {
      ...errorPayload(this),
      code: this.code,
    } satisfies MijiaErrorDetails;
  }
}

// Never forward upstream messages, causes, URLs, cookies or device payloads.
export function safeMijiaError(
  error: unknown,
  fallback: MijiaFailureReason = "internal_error",
) {
  if (error instanceof MijiaError) return error;
  if (error instanceof CredentialStoreError)
    return new MijiaError("credential_storage");
  if (error instanceof MiCloudError)
    return new MijiaError(miCloudReasons[error.code]);
  return new MijiaError(
    error instanceof Go2RtcError && isMijiaFailureReason(error.code)
      ? error.code
      : fallback,
  );
}

const recoverableReasons = new Set<MijiaFailureReason>([
  "network",
  "timeout",
  "go2rtc_unavailable",
  "request_timeout",
  "session_expired",
]);

export function isRecoverableMijiaError(error: unknown) {
  // Configuration, storage, protocol and unknown failures need a corrected input
  // or an explicit user retry. Classify before applying a display fallback.
  if (
    !(error instanceof MijiaError) &&
    !(error instanceof MiCloudError) &&
    !(error instanceof Go2RtcError)
  )
    return false;
  return recoverableReasons.has(safeMijiaError(error).reason);
}
