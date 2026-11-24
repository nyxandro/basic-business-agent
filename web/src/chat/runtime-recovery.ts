// The connection of the chat to the server's CopilotKit runtime (review 24.11). When `/info` fails — the server restarts,
// the network blinks — CopilotKit marks the connection broken and never tries again: the chat stayed dead until a
// reload, its «Отправить» doing nothing. Here the chat tries again by itself, less and less often, until it is back.
// CopilotKit connects anew when its address changes (`setRuntimeUrl`), so a try sets the address anew.
import { CopilotKitCoreRuntimeConnectionStatus, type CopilotKitCore } from '@copilotkit/react-core';
import { useEffect, useState } from 'react';

export const RETRY_FIRST_MS = 2_000;
export const RETRY_MAX_MS = 15_000;

export type RuntimeCore = Pick<CopilotKitCore, 'runtimeConnectionStatus' | 'subscribe' | 'setRuntimeUrl'>;

// `lost` — the chat cannot reach the server now; `generation` grows each time the connection comes back, so the chat
// connects its conversation anew.
export function useRuntimeRecovery(core: RuntimeCore, runtimeUrl: string): { lost: boolean; generation: number } {
  const [lost, setLost] = useState(core.runtimeConnectionStatus === CopilotKitCoreRuntimeConnectionStatus.Error);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let wasLost = core.runtimeConnectionStatus === CopilotKitCoreRuntimeConnectionStatus.Error;
    setLost(wasLost);
    const subscription = core.subscribe({
      onRuntimeConnectionStatusChanged: ({ status }) => {
        if (status === CopilotKitCoreRuntimeConnectionStatus.Error) {
          wasLost = true;
          setLost(true);
        } else if (status === CopilotKitCoreRuntimeConnectionStatus.Connected && wasLost) {
          wasLost = false;
          setLost(false);
          setGeneration((g) => g + 1);
        }
      },
    });
    return () => subscription.unsubscribe();
  }, [core]);

  useEffect(() => {
    if (!lost) return;
    let delay = RETRY_FIRST_MS;
    let timer: ReturnType<typeof setTimeout>;
    const tryAgain = () => {
      core.setRuntimeUrl(undefined);
      core.setRuntimeUrl(runtimeUrl);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
      timer = setTimeout(tryAgain, delay);
    };
    timer = setTimeout(tryAgain, delay);
    return () => clearTimeout(timer);
  }, [lost, core, runtimeUrl]);

  return { lost, generation };
}
