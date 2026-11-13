// Approval policy (spec, section 8.4): every tool that is not read-only waits for "Да"
// (Mastra requireApproval), and every such call that ran is written to the action journal.
import { createTool } from '@mastra/core/tools';
import type { Db } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';
import { writeJournal } from '../journal/journal.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import { REQUEST_KEYS, type RunKind } from '../runtime/request-keys.ts';
import { logEvent } from '../server/log.ts';

type ExecuteContext = { requestContext?: { get(key: string): unknown } } | undefined;

function contextValue(ctx: ExecuteContext, key: string): string | null {
  const v = ctx?.requestContext?.get(key);
  return typeof v === 'string' && v ? v : null;
}

export function applyApprovalPolicy(tool: AnyTool, opts: { readOnly: boolean; db: Db }): AnyTool {
  if (opts.readOnly) return createTool({ ...tool, requireApproval: false }) as AnyTool;
  const execute = tool.execute!.bind(tool) as (input: unknown, ctx: ExecuteContext) => Promise<unknown>;
  return createTool({
    ...tool,
    requireApproval: true,
    execute: async (input: unknown, ctx: ExecuteContext) => {
      const userId = contextValue(ctx, REQUEST_KEYS.userId);
      const runKind = (contextValue(ctx, REQUEST_KEYS.runKind) ?? 'chat') as RunKind;
      const base = {
        userId,
        agentId: contextValue(ctx, REQUEST_KEYS.agentId),
        runKind: runKind === 'background' ? ('background' as const) : ('chat' as const),
        taskId: contextValue(ctx, REQUEST_KEYS.taskId),
        event: 'tool_call' as const,
        tool: String(tool.id),
        args: input,
        // The tool runs only after the employee answered "Да" — in the chat or on the approvals screen.
        approvedBy: userId,
      };
      try {
        const output = await execute(input, ctx);
        await writeJournal(opts.db, { ...base, result: 'ok' });
        return output;
      } catch (error) {
        const errorCode = isAppError(error) ? error.code : 'APP_TOOL_FAILED';
        await writeJournal(opts.db, { ...base, result: 'error', errorCode });
        logEvent('warn', 'tool_failed', { tool: base.tool, agentId: base.agentId, code: errorCode, error });
        throw error;
      }
    },
  } as Parameters<typeof createTool>[0]) as AnyTool;
}
