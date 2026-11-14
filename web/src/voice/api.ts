// POST /app/api/voice/transcribe (spec, section 8.14): the recording and the conversation's agent.
import { apiForm } from '../api/client.ts';

export function transcribe(audio: Blob, agentId: string): Promise<{ text: string }> {
  const form = new FormData();
  // The server names the file by its type; this name only fills the multipart field.
  form.append('file', new File([audio], 'voice', { type: audio.type }));
  form.append('agentId', agentId);
  return apiForm<{ text: string }>('/app/api/voice/transcribe', form);
}
