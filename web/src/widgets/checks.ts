// The first failed check of a control, read the way CopilotKit's own controls read it (@copilotkit/shared, checks): the
// runtime has already computed each condition — a boolean or a validation result.
interface Check {
  condition?: boolean | { valid?: boolean; message?: string; severity?: string } | null;
  message?: string;
}

export interface FailedCheck {
  message: string;
  severity: string;
}

export function firstFailedCheck(checks: unknown): FailedCheck | undefined {
  let first: FailedCheck | undefined;
  for (const check of (Array.isArray(checks) ? checks : []) as Check[]) {
    const { condition } = check;
    if (condition === undefined || condition === null) continue;
    let failed: FailedCheck;
    if (typeof condition === 'boolean') {
      if (condition) continue;
      failed = { message: check.message ?? 'Invalid value', severity: 'error' };
    } else {
      if (condition.valid) continue;
      failed = { message: check.message ?? condition.message ?? 'Invalid value', severity: condition.severity ?? 'error' };
    }
    if (failed.severity === 'error') return failed;
    first ??= failed;
  }
  return first;
}
