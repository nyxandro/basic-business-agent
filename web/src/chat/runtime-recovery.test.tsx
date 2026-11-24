// The chat when the server did not answer as the page opened (review 24.11): CopilotKit marks its connection broken and
// never tries again, so the chat stayed dead until a reload. Now it tries again by itself and comes back.
import { CopilotKitCoreRuntimeConnectionStatus as Status } from '@copilotkit/react-core';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RETRY_FIRST_MS, RETRY_MAX_MS, useRuntimeRecovery, type RuntimeCore } from './runtime-recovery.ts';

const URL = '/app/api/copilotkit';

function fakeCore(status: Status) {
  const listeners = new Set<(event: { status: Status }) => void>();
  const core = {
    runtimeConnectionStatus: status,
    urls: [] as (string | undefined)[],
    subscribe: ({ onRuntimeConnectionStatusChanged }: { onRuntimeConnectionStatusChanged?: (event: { status: Status }) => void }) => {
      const listener = (event: { status: Status }) => void onRuntimeConnectionStatusChanged?.(event);
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    setRuntimeUrl: (url: string | undefined) => void core.urls.push(url),
    become(next: Status) {
      core.runtimeConnectionStatus = next;
      for (const tell of listeners) tell({ status: next });
    },
  };
  return core;
}

const asCore = (core: ReturnType<typeof fakeCore>) => core as unknown as RuntimeCore;
const onRecovered = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  onRecovered.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('useRuntimeRecovery', () => {
  it('does nothing while the connection is fine', () => {
    const core = fakeCore(Status.Connected);
    const { result } = renderHook(() => useRuntimeRecovery(asCore(core), URL, onRecovered));
    act(() => void vi.advanceTimersByTime(RETRY_MAX_MS * 3));
    expect(result.current.lost).toBe(false);
    expect(core.urls).toEqual([]);
  });

  it('tries the connection again, less and less often, until it is back; then the chat connects anew', () => {
    const core = fakeCore(Status.Error);
    const { result } = renderHook(() => useRuntimeRecovery(asCore(core), URL, onRecovered));
    expect(result.current.lost).toBe(true);
    expect(core.urls).toEqual([]);
    act(() => void vi.advanceTimersByTime(RETRY_FIRST_MS));
    // A try: the address is set anew, which is how CopilotKit connects again.
    expect(core.urls).toEqual([undefined, URL]);
    act(() => void vi.advanceTimersByTime(RETRY_FIRST_MS));
    expect(core.urls).toHaveLength(2);
    act(() => void vi.advanceTimersByTime(RETRY_FIRST_MS));
    expect(core.urls).toHaveLength(4);
    const generation = result.current.generation;
    act(() => core.become(Status.Connected));
    expect(result.current.lost).toBe(false);
    expect(result.current.generation).toBe(generation + 1);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(RETRY_MAX_MS * 3));
    expect(core.urls).toHaveLength(4);
  });

  it('notices a connection that breaks later and keeps the tries no rarer than the limit', () => {
    const core = fakeCore(Status.Connected);
    const { result } = renderHook(() => useRuntimeRecovery(asCore(core), URL, onRecovered));
    act(() => core.become(Status.Error));
    expect(result.current.lost).toBe(true);
    act(() => void vi.advanceTimersByTime(RETRY_MAX_MS * 20));
    const tries = core.urls.length / 2;
    expect(tries).toBeGreaterThanOrEqual(20);
  });
});
