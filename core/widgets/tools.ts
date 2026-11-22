// Tools of widgets in the chat (spec, section 8.31): `ui_components` gives the full description of the components
// the agent is about to use (a short list of all of them is in every request), `render_ui` takes a screen and checks it
// against the catalog before the person sees it. A failed check goes back to the model with the reasons, by the number
// of the operation, and the browser draws nothing for that call. Only the agent the person talks to gets them, with
// «Виджеты в чате» on (core/runtime/agent-factory.ts).
import { operationsOf, renderUiArgsSchema, WIDGET_COMPONENTS, WIDGET_TOOL, type RenderUiResult } from '@bba/contracts';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { AnyTool } from '../plugins/public/index.ts';
import { logEvent } from '../server/log.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { screensOfStoredAnswer } from './answer-screens.ts';
import { checkScreen, componentsGuide, unknownComponents, type ShownScreen, type ShownScreens } from './catalog.ts';

const componentsInput = z.object({
  names: z
    .array(z.string())
    .min(1)
    .max(WIDGET_COMPONENTS.length)
    .describe('Имена всех компонентов будущего экрана сразу — из списка в разделе «Виджеты в чате»'),
});

const COMPONENTS_DESCRIPTION = 'Первый шаг виджета — экрана в чате вместо простыни текста. Нужен, когда показываешь сотруднику три и больше однотипных записей (письма, сделки, задачи, документы, клиенты, позиции), сводку или отчёт с цифрами, сравнение вариантов, расчёт, который захочется подвигать, или форму. Возвращает подробное описание компонентов: поля, события, правила записи экрана для render_ui. Вызывай перед render_ui, один раз на экран, сразу со всеми компонентами, которые понадобятся.';
const RENDER_DESCRIPTION = 'Показать сотруднику виджет — экран из компонентов: записи карточками или таблицей, сводку цифрами и графиком, сравнение рядом, калькулятор, форму. Один вызов — один экран: операции A2UI 1.0 по описанию из ui_components. Новый экран начинается с createSurface; экран, показанный раньше в этом ответе, меняется на месте вызовом, который начинается с updateComponents или updateDataModel для его surfaceId. Сервер проверяет экран и возвращает ошибки, если они есть.';

// The one field of a result the agent follows (the core's rules, «Чьи указания»): a constant text, never the screen's
// words. Without it the agent retold the screen in words after 3 screens of 4 (M11, 20.11).
export const SHOWN_NOTE = 'Экран уже на виду у сотрудника. Не пересказывай текстом то, что на нём видно, — ни цифр, ни строк, ни полей; если нужно, допиши одну-две фразы вывода. Вопросов «Хочешь, …?» в конце не задавай.';

// The model fixes a screen by these lines; it is told to answer in text after two failures (the core's rules).
const REBUILD = 'Исправь это и вызови render_ui заново, целиком. После двух неудач ответь сотруднику текстом.';

type Failure = { error: true; code: string; message: string };

type RunContext = { get(key: string): unknown; set(key: string, value: unknown): void } | undefined;

type AgentContext = { getMessages?: () => readonly { role: string; content?: unknown }[] } | undefined;

// The screens of this answer in the request's context. Usually the processor of the request put them there before the
// first model call (history.ts); a call that runs before any — queued behind an action that waited for «Да» — reads them
// from the stored conversation itself (issue #25).
function shownIn(ctx: RunContext, agent: AgentContext): ShownScreens {
  if (!ctx) throw new Error('render_ui called without a request context: the run was started outside a core entry point');
  const existing = ctx.get(REQUEST_KEYS.widgetScreens);
  if (existing instanceof Map) return existing as ShownScreens;
  const screens: ShownScreens = agent?.getMessages ? screensOfStoredAnswer(agent.getMessages()) : new Map<string, ShownScreen>();
  ctx.set(REQUEST_KEYS.widgetScreens, screens);
  return screens;
}

export function createWidgetTools(): Record<string, AnyTool> {
  const components = createTool({
    id: WIDGET_TOOL.components,
    description: COMPONENTS_DESCRIPTION,
    inputSchema: componentsInput,
    execute: ({ names }): Promise<{ guide: string } | Failure> => {
      const unique = [...new Set(names)];
      const unknown = unknownComponents(unique);
      if (unknown.length > 0) {
        return Promise.resolve({ error: true, code: 'APP_WIDGET_UNKNOWN_COMPONENT', message: `Таких компонентов нет: ${unknown.join(', ')}. Есть: ${WIDGET_COMPONENTS.join(', ')}.` });
      }
      return Promise.resolve({ guide: componentsGuide(unique) });
    },
  });

  const render = createTool({
    id: WIDGET_TOOL.render,
    description: RENDER_DESCRIPTION,
    inputSchema: renderUiArgsSchema,
    execute: (input, context): Promise<RenderUiResult> => {
      const operations = operationsOf(input);
      const verdict = checkScreen(operations, shownIn(context?.requestContext, context?.agent));
      if (verdict.ok) {
        logEvent('info', 'widget_shown', { operations: operations.length, created: verdict.created });
        return Promise.resolve({ shown: true, surfaceId: verdict.surfaceId, note: SHOWN_NOTE });
      }
      logEvent('info', 'widget_refused', { operations: operations.length, problems: verdict.problems.length });
      return Promise.resolve({ error: true, code: 'APP_WIDGET_INVALID', message: `Экран не собран:\n- ${verdict.problems.join('\n- ')}\n${REBUILD}` } as const);
    },
  });

  return { [components.id]: components as AnyTool, [render.id]: render as AnyTool };
}
