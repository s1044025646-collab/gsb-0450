export const ERR = {
  INVALID_ID: 'INVALID_ID',
  DUPLICATE_ID: 'DUPLICATE_ID',
  NEGATIVE_TIME: 'NEGATIVE_TIME',
  NON_POSITIVE_BURST: 'NON_POSITIVE_BURST',
  NON_INTEGER: 'NON_INTEGER',
  UNSAFE_INTEGER: 'UNSAFE_INTEGER',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  EMPTY_JOBSET: 'EMPTY_JOBSET',
  NOT_FOUND: 'NOT_FOUND',
  BAD_JSON: 'BAD_JSON',
  BAD_REQUEST: 'BAD_REQUEST',
} as const;

export type ErrorCode = (typeof ERR)[keyof typeof ERR];

export class SchedError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SchedError';
  }
}
