// One catalog block drawn from a tool call: a placeholder while the model is still writing the
// arguments, the block when they fit the catalog, «Не удалось показать данные» with the data as
// text when they do not (the server refused them, or an older version saved them).
import type { ComponentType } from 'react';
import type { z } from 'zod';
import { parseToolResult } from '../chat/tool-result.ts';
import { ru } from '../i18n/ru.ts';
import { BrokenData } from './BrokenData.tsx';

export interface CallProps {
  toolCallId: string;
  status: 'inProgress' | 'executing' | 'complete';
  parameters: unknown;
  result: string | undefined;
}

export function CatalogBlock<T>({ call, schema, View }: { call: CallProps; schema: z.ZodType<T>; View: ComponentType<{ block: T }> }) {
  if (call.status === 'inProgress') return <div className="genui genui-pending">{ru.genui.preparing}</div>;
  if (call.status === 'complete' && parseToolResult(call.result).kind === 'failed') return <BrokenData data={call.parameters} />;
  const parsed = schema.safeParse(call.parameters);
  return parsed.success ? <View block={parsed.data} /> : <BrokenData data={call.parameters} />;
}
