// The light running over the words of an answer while they are written (chat.module.css, `.answer`):
// it does not stop when the last word comes but goes out softly, so it stays on a little longer.
import { useEffect, useState } from 'react';

// How long the light takes to go out; the same value goes to the CSS (--shimmer-fade on the answer).
export const SHIMMER_FADE_MS = 600;

/** On while the answer is written and SHIMMER_FADE_MS after, for the light to go out. */
export function useShimmer(writing: boolean): boolean {
  const [fading, setFading] = useState(false);
  const [wasWriting, setWasWriting] = useState(writing);

  if (wasWriting !== writing) {
    setWasWriting(writing);
    setFading(!writing);
  }

  useEffect(() => {
    if (!fading) return;
    const timer = window.setTimeout(() => setFading(false), SHIMMER_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [fading]);

  return writing || fading;
}
