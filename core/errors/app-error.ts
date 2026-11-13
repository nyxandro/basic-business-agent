// Errors that cross a boundary (HTTP, CLI, background run) carry three things (spec, section 9):
// a stable code, a plain-Russian message for the person and, when there is one, the next step.
// The technical description stays in `message` (English) and goes to the logs only.
export interface AppErrorInit {
  code: `APP_${string}`;
  message: string;
  userMessage: string;
  nextStep?: string;
  status?: number;
  cause?: unknown;
  details?: Record<string, unknown>;
}

const DEFAULT_STATUS = 500;

export class AppError extends Error {
  readonly code: `APP_${string}`;
  readonly userMessage: string;
  readonly nextStep: string | undefined;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(init: AppErrorInit) {
    super(`${init.code}: ${init.message}`, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'AppError';
    this.code = init.code;
    this.userMessage = init.userMessage;
    this.nextStep = init.nextStep;
    this.status = init.status ?? DEFAULT_STATUS;
    this.details = init.details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
