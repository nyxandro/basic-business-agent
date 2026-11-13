// Structured log lines (JSON, English) to stdout/stderr. Never pass secrets or personal data here.
type Level = 'info' | 'warn' | 'error';

function serialise(value: unknown): unknown {
  if (value instanceof Error) {
    const cause = (value as { cause?: unknown }).cause;
    return { name: value.name, message: value.message, stack: value.stack, ...(cause !== undefined ? { cause: serialise(cause) } : {}) };
  }
  return value;
}

export function logEvent(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    level,
    at: new Date().toISOString(),
    event,
    ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, serialise(v)])),
  });
  if (level === 'error') console.error(line);
  else console.log(line);
}
