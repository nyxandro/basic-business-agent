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
export const renderUiArgsSchema = z.object({
  target: z.literal(WIDGET_CHAT_TARGET).optional(),
  operations: z.preprocess(listFromText, z.array(z.record(z.string(), z.unknown())).min(1).max(200)),
});

// Every operation of A2UI 1.0 carries this mark; a model that leaves it out means the same operation.
export const A2UI_VERSION_MARK = '1.0';
export const withA2uiVersion = (op: Record<string, unknown>): Record<string, unknown> => (op.version === undefined ? { version: A2UI_VERSION_MARK, ...op } : op);

// The operations of a call as the server checked them: the list (also when written as a JSON string), each with its
// version. The browser draws by the same reading.
export function operationsOf(parameters: unknown): Record<string, unknown>[] {
  const raw = parameters && typeof parameters === 'object' ? listFromText((parameters as { operations?: unknown }).operations) : undefined;
  return Array.isArray(raw) ? raw.filter((op): op is Record<string, unknown> => !!op && typeof op === 'object' && !Array.isArray(op)).map(withA2uiVersion) : [];
}
export type RenderUiArgs = z.infer<typeof renderUiArgsSchema>;

// What render_ui answers: the screen is shown, or why not (the model gets the reasons and rebuilds it).
export const renderUiResultSchema = z.union([
  z.object({ shown: z.literal(true), surfaceId: z.string() }),
  z.object({ error: z.literal(true), code: z.string(), message: z.string() }),
]);
export type RenderUiResult = z.infer<typeof renderUiResultSchema>;
