// The picture of the marks goes into the hidden folder «.marks» of the conversation's folder (spec, section 8.32).
import type { UploadedFile } from '@bba/contracts';
import { apiForm } from '../../api/client.ts';

export function uploadMarksPicture(threadId: string, picture: File): Promise<UploadedFile> {
  const form = new FormData();
  form.append('file', picture);
  return apiForm<UploadedFile>(`/app/api/threads/${encodeURIComponent(threadId)}/marks`, form);
}
