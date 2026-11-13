// Limits how many sandbox commands run at once in the installation (spec, section 8.7):
// the rest wait in a queue, and after the wait limit get APP_SANDBOX_BUSY.
import { appError } from '../errors/catalog.ts';

export const MAX_CONCURRENT_COMMANDS = 8;
export const QUEUE_TIMEOUT_MS = 60_000;

export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  active(): number;
}

export function createLimiter(max: number, queueTimeoutMs: number): Limiter {
  let running = 0;
  const waiting: { resolve: () => void; timer: NodeJS.Timeout }[] = [];

  function release(): void {
    const next = waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else {
      running--;
    }
  }

  function acquire(): Promise<void> {
    if (running < max) {
      running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        timer: setTimeout(() => {
          waiting.splice(waiting.indexOf(entry), 1);
          reject(appError('APP_SANDBOX_BUSY', `sandbox queue wait exceeded ${queueTimeoutMs} ms with ${running} commands running`));
        }, queueTimeoutMs),
      };
      waiting.push(entry);
    });
  }

  return {
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    active: () => running,
  };
}
