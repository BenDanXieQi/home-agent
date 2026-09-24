import { errorDefinitions } from "./definitions";
import { type ApiError, type ErrorCode } from "../contracts";

export type AppErrorOptions = Pick<ApiError, "params" | "issues"> &
  ErrorOptions & { operation?: string };

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly operation: string | undefined;
  readonly details: Pick<ApiError, "params" | "issues">;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(errorDefinitions[code].message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.operation = options.operation;
    this.details = {
      ...(options.params ? { params: options.params } : {}),
      ...(options.issues ? { issues: options.issues } : {}),
    };
  }
}

export function errorPayload(error: AppError, traceId?: string): ApiError {
  return {
    code: error.code,
    message: errorDefinitions[error.code].message,
    ...error.details,
    ...(traceId ? { traceId } : {}),
  };
}

export { validationIssues } from "./validation";
