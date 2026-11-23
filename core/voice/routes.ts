// POST /app/api/voice/transcribe (spec, section 17.5): a recording of the signed-in employee, for
// the agent of the conversation where it was made; the answer is the text for the draft.
import type { Hono } from 'hono';
import { assertAgentOpen } from '../chat/run.ts';
import type { Registry } from '../loader/registry.ts';
import { readUploadedFile } from '../projects/routes.ts';
import { access, type AppEnv } from '../http/http.ts';
import { appError } from '../errors/catalog.ts';
import { transcribe, type VoiceDeps } from './transcribe.ts';

export function registerVoiceRoutes(app: Hono<AppEnv>, deps: VoiceDeps & { registry: Registry }): void {
  app.post('/app/api/voice/transcribe', async (c) => {
    const file = await readUploadedFile(c);
    const agentId = (await c.req.parseBody()).agentId;
    if (typeof agentId !== 'string' || agentId === '') throw appError('APP_VALIDATION_FAILED', 'no agentId field');
    assertAgentOpen(deps, access(c), agentId, 'published');
    return c.json({ text: await transcribe(deps, access(c).userId, agentId, file) });
  });
}
