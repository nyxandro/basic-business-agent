// The descriptions of components the agent loaded in earlier turns are not sent to the model again (spec, section
// 8.31): one costs ~7 thousand tokens, and the conversation history goes with every request. Only the outgoing request
// is changed (`processLLMRequest`): Mastra's history keeps them, and the agent loads them again when it draws next time.
// The current turn — everything after the person's last message — keeps them: the agent is drawing with them now.
// Before the first model call of a request the same processor gives the request the screens the answer showed before
// a pause on «Да», «Нет» or the browser (answer-screens.ts): `render_ui` may change them in place.
import { WIDGET_TOOL } from '@bba/contracts';
import type { Processor } from '@mastra/core/processors';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { screensOfAnswer } from './answer-screens.ts';

export const DESCRIPTION_DROPPED = `Описание компонентов убрано из истории. Чтобы нарисовать новый экран, вызови ${WIDGET_TOOL.components} заново.`;

type Part = { type?: unknown; toolName?: unknown; output?: unknown };
type PromptMessage = { role: string; content: unknown };

const isDescription = (part: unknown): part is Part => !!part && typeof part === 'object' && (part as Part).type === 'tool-result' && (part as Part).toolName === WIDGET_TOOL.components;

export function dropOldDescriptions<T extends PromptMessage>(prompt: readonly T[]): T[] | null {
  const lastUser = prompt.findLastIndex((m) => m.role === 'user');
  let changed = false;
  const out = prompt.map((message, i) => {
    if (i >= lastUser || message.role !== 'tool' || !Array.isArray(message.content) || !message.content.some(isDescription)) return message;
    changed = true;
    return { ...message, content: message.content.map((part: unknown) => (isDescription(part) ? { ...part, output: { type: 'text', value: DESCRIPTION_DROPPED } } : part)) };
  });
  return changed ? out : null;
}

export function createWidgetHistoryProcessor() {
  return {
    id: 'bba-widget-descriptions',
    processLLMRequest({ prompt, requestContext }) {
      if (requestContext && !(requestContext.get(REQUEST_KEYS.widgetScreens) instanceof Map)) requestContext.set(REQUEST_KEYS.widgetScreens, screensOfAnswer(prompt as PromptMessage[]));
      const dropped = dropOldDescriptions(prompt as PromptMessage[]);
      return dropped ? { prompt: dropped as typeof prompt } : undefined;
    },
  } satisfies Processor;
}
