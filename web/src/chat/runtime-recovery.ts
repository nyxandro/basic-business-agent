// The connection of the chat to the server's CopilotKit runtime (review 24.11). When `/info` fails as the page opens — the
// server restarts, the network blinks — CopilotKit marks the connection broken, knows no agent and never tries again:
// the chat stayed dead until a reload, its «Отправить» doing nothing. Here the chat tries again by itself, less and less
// often, until it is back. CopilotKit connects anew when its address changes (`setRuntimeUrl`), so a try sets it anew.
// A connection that broke after it had worked is left to CopilotKit: it keeps its agents then and sending goes on
// through them, while a new address would drop them with the answer under way (independent review 24.11).
import { CopilotKitCoreRuntimeConnectionStatus as Status, type CopilotKitCore } from '@copilotkit/react-core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export const RETRY_FIRST_MS = 2_000;
export const RETRY_MAX_MS = 15_000;

export type RuntimeCore = Pick<CopilotKitCore, 'runtimeConnectionStatus' | 'subscribe' | 'setRuntimeUrl'>;

// `lost` — the chat has not reached the server since the page opened; `generation` grows when it does after that, so
// the chat connects its conversation anew; `onRecovered` is told then (the chat drops the failure the lost connection
// caused).
export function useRuntimeRecovery(core: RuntimeCore, runtimeUrl: string, onRecovered: () => void): { lost: boolean; generation: number } {
  const [lost, setLost] = useState(core.runtimeConnectionStatus === Status.Error);
  const [generation, setGeneration] = useState(0);
  const recovered = useRef(onRecovered);
  useLayoutEffect(() => {
    recovered.current = onRecovered;
  });

  useEffect(() => {
    let everConnected = core.runtimeConnectionStatus === Status.Connected;
    let wasLost = core.runtimeConnectionStatus === Status.Error;
    const subscription = core.subscribe({
      onRuntimeConnectionStatusChanged: ({ status }) => {
        if (status === Status.Error && !everConnected) {
          wasLost = true;
          setLost(true);
        } else if (status === Status.Connected) {
          everConnected = true;
          if (!wasLost) return;
          wasLost = false;
          setLost(false);
          setGeneration((g) => g + 1);
          recovered.current();
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
      // A try still under way is waited for: tries piling up would hold the browser's connections to the server.
      if (core.runtimeConnectionStatus !== Status.Connecting) {
        core.setRuntimeUrl(undefined);
        core.setRuntimeUrl(runtimeUrl);
      }
      delay = Math.min(delay * 2, RETRY_MAX_MS);
      timer = setTimeout(tryAgain, delay);
    };
    timer = setTimeout(tryAgain, delay);
    return () => clearTimeout(timer);
  }, [lost, core, runtimeUrl]);

  return { lost, generation };
}
