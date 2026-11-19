// The words of an answer as Markdown; while they are written a light runs over them (shimmer.ts),
// not over an answer that broke. The light is the only sign of writing: no caret of CopilotKit after the
// words (a stray dot, request of the owner 19.11). The wrapper stays the same element whatever the state,
// so the Markdown keeps what it has drawn.
import { StreamingMarkdownDefaultRenderer } from '@copilotkit/react-core';
import type { CSSProperties } from 'react';
import shimmerStyles from './answer-text.module.css';
import styles from './chat.module.css';
import { SHIMMER_FADE_MS, useShimmer } from './shimmer.ts';

const FADE_STYLE = { '--shimmer-fade': `${SHIMMER_FADE_MS}ms` } as CSSProperties;

export function AnswerText({ text, streaming, failed }: { text: string; streaming: boolean; failed: boolean }) {
  const lit = useShimmer(streaming) && !failed;
  const shimmer = !lit ? undefined : streaming ? 'writing' : 'fading';
  return (
    <div className={shimmerStyles.answer} data-answer-text data-shimmer={shimmer} style={FADE_STYLE}>
      <StreamingMarkdownDefaultRenderer content={text} isStreaming={streaming} caret={false} className={styles.markdown} />
    </div>
  );
}
