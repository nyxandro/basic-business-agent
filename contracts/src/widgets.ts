import { z } from 'zod';

// Widgets in the chat (spec, section 8.31): the agent builds a screen of its answer from the primitives of A2UI 1.0,
// and CopilotKit's engine draws it. The one list of what the agent may use: the server builds the descriptions for
// the model and checks a screen by it, the browser takes the same components from CopilotKit's standard catalog.

// The catalog of our widgets; a screen names it, and the server and the browser build it with this id.
export const WIDGET_CATALOG_ID = 'bba/widgets@1';

// The only place a screen of the chat goes; CopilotKit's guide names it as the `target` of `render_ui`.
export const WIDGET_CHAT_TARGET = 'chat';

// The 43 components the owner approved on 20.11 (docs/a2ui-primitives-list.md), in its order.
export const WIDGET_COMPONENTS = [
  'Box',
  'Column',
  'Row',
  'Grid',
  'GridItem',
  'Card',
  'Flow',
  'FlowItem',
  'Divider',
  'Tabs',
  'Title',
  'Text',
  'Caption',
  'Badge',
  'Markdown',
  'Math',
  'Link',
  'Tooltip',
  'Button',
  'Form',
  'TextField',
  'Select',
  'CheckBox',
  'RadioGroup',
  'Slider',
  'SegmentedControl',
  'ChoicePicker',
  'DateTimeInput',
  'Table',
  'TableSection',
  'TableRow',
  'TableCell',
  'List',
  'ListItem',
  'Chart',
  'Image',
  'Icon',
  'Popover',
  'PopoverTrigger',
  'PopoverContent',
  'Citation',
  'FollowUp',
  'EntityCard',
] as const;
export type WidgetComponent = (typeof WIDGET_COMPONENTS)[number];

// The standard components the agent does not get (the same document): CopilotKit's catalog minus these is ours.
export const WIDGET_OMITTED = [
  'Spacer',
  'Carousel',
  'CarouselItem',
  'CarouselMediaItem',
  'Label',
  'Bold',
  'Italic',
  'Underline',
  'Strikethrough',
  'Blockquote',
  'Code',
  'ShimmerText',
  'Pressable',
  'TextArea',
  'Radio',
  'Map',
  'Favicon',
  'Svg',
  'Video',
  'AudioPlayer',
  'HtmlView',
  'PulseIndicator',
  'FlashcardFlip',
  'Modal',
  'LinkCard',
  'ImageGrid',
] as const;

// Tools of the core for widgets: the descriptions of the components the agent is about to use, and the screen.
export const WIDGET_TOOL = {
  components: 'ui_components',
  render: 'render_ui',
} as const;
export const WIDGET_TOOL_IDS: readonly string[] = Object.values(WIDGET_TOOL);

// A model may write the list of operations as one JSON string: it is the same list.
function listFromText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

// The arguments of render_ui, as CopilotKit's guide tells the model to write them. Each operation is checked by the
// server against the catalog; here only its shape of a JSON object.
// A list that is not JSON reaches the server as a string (none of 11 such strings in M11, 20.11, was JSON: the model
// lost count of brackets, and the model's service passed the text on as it was — our reading, not checked). zod alone
// answers «expected array» and «string <=200 characters», and Mastra shows the model only the start of its arguments:
// the reason names the brackets and shows the text around the mistake.
const AROUND_MISTAKE = 60;

function notJson(text: string, error: Error): string {
  const at = Number(/position (\d+)/.exec(error.message)?.[1]);
  const place = Number.isFinite(at) ? `, около знака ${at}: «${text.slice(Math.max(0, at - AROUND_MISTAKE), at + AROUND_MISTAKE / 3)}»` : '';
  return `operations — не JSON (${error.message})${place}. Проверь парность скобок { } и [ ] и кавычек и вызови render_ui заново целиком; operations — массив объектов.`;
}

export const renderUiArgsSchema = z.object({
  target: z.literal(WIDGET_CHAT_TARGET).optional(),
  operations: z.preprocess((value, ctx) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value) as unknown;
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: notJson(value, error as Error) });
      return z.NEVER;
    }
  }, z.array(z.record(z.string(), z.unknown())).min(1).max(200).describe('Массив операций A2UI 1.0 — объекты JSON')),
});

// Every operation of A2UI 1.0 carries this mark; a model that leaves it out means the same operation.
export const A2UI_VERSION_MARK = '1.0';
export const withA2uiVersion = (op: Record<string, unknown>): Record<string, unknown> => (op.version === undefined ? { version: A2UI_VERSION_MARK, ...op } : op);

// Spacing is a number of 4 px steps or a CSS length in CopilotKit; the model writes it as the words of its sizes
// («md»), which the browser drops — the screen loses every gap (owner 20.11, «отступы отсутствуют»). The words are
// read as steps of the mockup's rhythm. `wrap` written as yes or no means wrapping or not. Only how the screen looks.
const SPACING_KEYS = ['gap', 'rowGap', 'columnGap', 'padding'];
const SPACING_STEPS: Record<string, number> = { none: 0, xs: 1, sm: 2, md: 3, lg: 4, xl: 6, '2xl': 8 };

function readComponent(component: unknown): unknown {
  if (!component || typeof component !== 'object' || Array.isArray(component)) return component;
  const out: Record<string, unknown> = { ...(component as Record<string, unknown>) };
  for (const key of SPACING_KEYS) {
    const value = out[key];
    if (typeof value === 'string' && value in SPACING_STEPS) out[key] = SPACING_STEPS[value];
  }
  if (typeof out.wrap === 'boolean') out.wrap = out.wrap ? 'wrap' : 'nowrap';
  return out;
}

function readOperation(op: Record<string, unknown>): Record<string, unknown> {
  const marked = withA2uiVersion(op);
  for (const kind of ['createSurface', 'updateComponents']) {
    const body = marked[kind];
    if (!body || typeof body !== 'object' || !Array.isArray((body as { components?: unknown }).components)) continue;
    return { ...marked, [kind]: { ...body, components: (body as { components: unknown[] }).components.map(readComponent) } };
  }
  return marked;
}

// The operations of a call as the server checked them: the list (also when written as a JSON string), each with its
// version, spacing and wrapping read as above. The browser draws by the same reading.
export function operationsOf(parameters: unknown): Record<string, unknown>[] {
  const raw = parameters && typeof parameters === 'object' ? listFromText((parameters as { operations?: unknown }).operations) : undefined;
  return Array.isArray(raw) ? raw.filter((op): op is Record<string, unknown> => !!op && typeof op === 'object' && !Array.isArray(op)).map(readOperation) : [];
}
export type RenderUiArgs = z.infer<typeof renderUiArgsSchema>;

// What render_ui answers: the screen is shown, or why not (the model gets the reasons and rebuilds it).
export const renderUiResultSchema = z.union([
  // `note` — for the model only: what to write after the screen (core/widgets/tools.ts).
  z.object({ shown: z.literal(true), surfaceId: z.string(), note: z.string() }),
  z.object({ error: z.literal(true), code: z.string(), message: z.string() }),
]);
export type RenderUiResult = z.infer<typeof renderUiResultSchema>;
