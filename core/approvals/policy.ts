// Approval policy (spec, section 8.4): every tool that is not read-only waits for "Да"
// (Mastra requireApproval), and every such call that ran is written to the action journal.
// Multi-step approvals (docs/specs/[20.11.2026]-multi-step-approvals.md): an action under a rule — read-only too, the
// rule outranks the mark — after «Да» becomes a request instead of running (chains.ts); the run gets «отправлено на
// согласование». The execution of an agreed request calls the same tool with the request's mark and runs it.
import { createTool } from '@mastra/core/tools';
import type { Db } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';
import { writeJournal } from '../journal/journal.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import { optionalContextValue, REQUEST_KEYS, type RunKind } from '../runtime/request-keys.ts';
import { logEvent } from '../server/log.ts';
import type { ChainService } from './chains.ts';
import { describeTool } from './describe.ts';

type ExecuteContext = { requestContext?: { get(key: string): unknown }; agent?: { toolCallId?: string } } | undefined;

function contextValue(ctx: ExecuteContext, key: string): string | null {
  const v = ctx?.requestContext?.get(key);
  return typeof v === 'string' && v ? v : null;
}

export function applyApprovalPolicy(tool: AnyTool, opts: { readOnly: boolean; db: Db; chains: ChainService }): AnyTool {
  const id = String(tool.id);
  const execute = tool.execute!.bind(tool) as (input: unknown, ctx: ExecuteContext) => Promise<unknown>;
  // A read-only action waits for «Да» only while a rule is on it.
  const requireApproval = opts.readOnly ? async () => opts.chains.rulesApply(id) : true;
  return createTool({
    ...tool,
    // A tool under a rule answers with the request, not with the shape it describes: Mastra would check the answer
    // against the declared shape and give the model an error instead of «отправлено».
    outputSchema: undefined,
    requireApproval,
    execute: async (input: unknown, ctx: ExecuteContext) => {
      const userId = contextValue(ctx, REQUEST_KEYS.userId);
      const runKind = (contextValue(ctx, REQUEST_KEYS.runKind) ?? 'chat') as RunKind;
      const chainId = optionalContextValue(ctx?.requestContext, REQUEST_KEYS.chainExecution);
      if (!chainId && (await opts.chains.rulesApply(id))) {
        if (!userId) throw new Error(`a call of ${id} under an approval rule without a person in the run`);
        const toolCallId = ctx?.agent?.toolCallId;
        if (!toolCallId) throw new Error(`a call of ${id} under an approval rule without its call id`);
        return opts.chains.send({
          userId,
          agentId: contextValue(ctx, REQUEST_KEYS.agentId) ?? '',
          threadId: contextValue(ctx, REQUEST_KEYS.threadId) ?? '',
          projectId: contextValue(ctx, REQUEST_KEYS.projectId),
          runKind: runKind === 'background' ? 'background' : 'chat',
          taskId: contextValue(ctx, REQUEST_KEYS.taskId),
          target: id,
          args: input,
          action: describeTool(tool),
          toolCallId,
        });
      }
      if (opts.readOnly && !chainId) return execute(input, ctx);
      const base = {
        userId,
        agentId: contextValue(ctx, REQUEST_KEYS.agentId),
        runKind: runKind === 'background' ? ('background' as const) : ('chat' as const),
        taskId: contextValue(ctx, REQUEST_KEYS.taskId),
        event: 'tool_call' as const,
        tool: id,
        args: input,
        // The tool runs only after the employee answered "Да" — in the chat or on the approvals screen — and, for a
        // request, after every stage agreed.
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
