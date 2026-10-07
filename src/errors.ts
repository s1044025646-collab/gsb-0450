export type ErrorCode =
  | "E_BAD_JSON"
  | "E_NO_JOBS"
  | "E_INVALID_ID"
  | "E_DUP_ID"
  | "E_NEGATIVE_TIME"
  | "E_NON_INTEGER"
  | "E_NON_POSITIVE_BURST"
  | "E_TOO_MANY_JOBS"
  | "E_OVERFLOW"
  | "E_JOBSET_NOT_FOUND"
  | "E_RUN_NOT_FOUND"
  | "E_JOB_NOT_FOUND"
  | "E_TIME_OUT_OF_RANGE"
  | "E_BAD_REQUEST";

export class SchedError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "SchedError";
  }
}

export function toErrorPayload(err: unknown): { code: string; message: string } {
  if (err instanceof SchedError) return { code: err.code, message: err.message };
  return { code: "E_INTERNAL", message: err instanceof Error ? err.message : String(err) };
}
