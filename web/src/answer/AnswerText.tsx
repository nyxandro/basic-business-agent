// The words of an answer as Markdown; while they are written a light runs over them (shimmer.ts),
// not over an answer that broke. The light is the only sign of writing: no caret of CopilotKit after the
// words (a stray dot, request of the owner 19.11). The wrapper stays the same element whatever the state,
// so the Markdown keeps what it has drawn.
import { StreamingMarkdownDefaultRenderer } from '@copilotkit/react-core';
import type { ComponentProps, CSSProperties } from 'react';
import { ru } from '../i18n/ru.ts';
import styles from './answer-text.module.css';
import { SHIMMER_FADE_MS, useShimmer } from './shimmer.ts';

const FADE_STYLE = { '--shimmer-fade': `${SHIMMER_FADE_MS}ms` } as CSSProperties;

// A picture of an answer comes only from our own server (spec, section 8.30; decision of the owner 19.11): the
// browser loading a picture from elsewhere would carry out whatever the agent was made to put into its address.
// Another site's picture is a link the person may open; Caddy's Content-Security-Policy refuses it besides.
function ownAddress(url: string): URL | null {
  if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) return null;
  const parsed = new URL(url, window.location.origin);
  return parsed.origin === window.location.origin ? parsed : null;
}

// Where a picture of another site is: http(s) only — a `data:` picture is not a place to name.
function foreign(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    // Not an address at all: the note says only that there was a picture.
    return '';
  }
}

// Also the rule of the Markdown of a widget (web/src/widgets/overrides.tsx).
export const OWN_PICTURES_ONLY: NonNullable<ComponentProps<typeof StreamingMarkdownDefaultRenderer>['nodeRenderers']> = {
  image: ({ node }) => {
    const own = ownAddress(node.url);
    if (own) return <img src={own.pathname + own.search} alt={node.alt} className={styles.answerImage} />;
    const where = foreign(node.url);
    return where ? (
      <a href={node.url} target="_blank" rel="noopener noreferrer" className={styles.foreignImage}>
        {ru.chat.foreignImage(where)}
      </a>
    ) : (
      <span className={styles.foreignImage}>{ru.chat.foreignImage('')}</span>
    );
  },
};

export function AnswerText({ text, streaming, failed }: { text: string; streaming: boolean; failed: boolean }) {
  const lit = useShimmer(streaming) && !failed;
  const shimmer = !lit ? undefined : streaming ? 'writing' : 'fading';
  return (
    <div className={styles.answer} data-answer-text data-shimmer={shimmer} style={FADE_STYLE}>
      <StreamingMarkdownDefaultRenderer content={text} isStreaming={streaming} caret={false} className={styles.markdown} nodeRenderers={OWN_PICTURES_ONLY} />
    </div>
  );
}
