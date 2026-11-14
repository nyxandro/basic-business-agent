// Voice input (spec, section 8.14): a recording goes to LiteLLM's /v1/audio/transcriptions on the
// employee's own key, with the recognition model chosen in «Нейросеть» and the agent of the
// conversation named for the ledger. The recording is not kept: it passes through memory only.
import type { Db } from '../db/pool.ts';
import type { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import type { ModelGateway } from '../models/gateway.ts';

export interface VoiceDeps {
  db: Db;
  gateway: Pick<ModelGateway, 'modelConfig' | 'assertWithinBudget' | 'translateError'>;
}

// What MediaRecorder writes (Chrome and Firefox — webm, Safari — mp4) and common audio files.
// Providers tell the format by the file name, so the name gets the matching extension.
const EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
};

// The recognition model in use, or null when none is chosen or it is switched off.
export async function recognitionModel(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT m.id FROM app.model_settings s JOIN app.models m ON m.id = s.transcription_model_id WHERE m.enabled AND m.kind = 'transcription'`,
  );
  return rows[0]?.id ?? null;
}

export function audioName(type: string): string {
  const extension = EXTENSIONS[type.split(';')[0]!.trim().toLowerCase()];
  if (!extension) throw appError('APP_VALIDATION_FAILED', `not an audio recording: "${type}"`, { userMessage: 'Это не запись голоса. Запишите сообщение ещё раз.' });
  return `voice.${extension}`;
}

export async function transcribe(deps: VoiceDeps, userId: string, agentId: string, audio: File): Promise<string> {
  const name = audioName(audio.type);
  const modelId = await recognitionModel(deps.db);
  if (!modelId) throw appError('APP_VOICE_NOT_CONFIGURED', 'no enabled recognition model is chosen');
  await deps.gateway.assertWithinBudget(userId);
  const call = await deps.gateway.modelConfig(modelId, userId, agentId);
  const form = new FormData();
  form.append('model', modelId);
  form.append('file', new File([audio], name, { type: audio.type }));

  let res: Response;
  try {
    res = await fetch(`${call.url.replace(/\/$/, '')}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${call.apiKey}`, ...call.headers }, body: form });
  } catch (error) {
    throw await failed(deps, userId, error);
  }
  const body = await res.text();
  if (!res.ok) throw await failed(deps, userId, Object.assign(new Error(`recognition answered ${res.status}`), { statusCode: res.status, responseBody: body.slice(0, 500) }));
  const text = (JSON.parse(body) as { text?: unknown }).text;
  if (typeof text !== 'string' || text.trim() === '') throw appError('APP_VOICE_FAILED', 'recognition returned no text');
  return text.trim();
}

// A spent limit stays a limit for the person; anything else is "not recognised".
async function failed(deps: VoiceDeps, userId: string, error: unknown): Promise<AppError> {
  const translated = await deps.gateway.translateError(error, userId);
  if (translated.code.startsWith('APP_USAGE_')) return translated;
  return appError('APP_VOICE_FAILED', `recognition failed: ${translated.message}`, { cause: error });
}
