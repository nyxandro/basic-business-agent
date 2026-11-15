// The agent's picture as the server accepts it (spec, section 8.17). The browser has already cut and
// scaled it, but the server does not rely on that: only PNG, JPEG or WebP, told by the first bytes
// (never by the name or the declared type), and at most AGENT_IMAGE_MAX_BYTES. SVG is refused: it
// may carry a script that would run on our address.
import { createHash } from 'node:crypto';
import { AGENT_IMAGE_MAX_BYTES } from '@bba/contracts';
import { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';

export type AgentImageType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface AgentImage {
  bytes: Uint8Array;
  type: AgentImageType;
  sha256: string;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
// A WebP file is a RIFF container: "RIFF", four bytes of length, "WEBP".
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];
const WEBP_TAG_OFFSET = 8;

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) => bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

export function imageTypeOf(bytes: Uint8Array): AgentImageType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, WEBP_TAG_OFFSET)) return 'image/webp';
  return null;
}

const FORMAT_MESSAGE = 'Не получилось открыть картинку. Нужен PNG, JPEG или WebP — сохраните её в одном из этих форматов и выберите снова.';
const SIZE_MESSAGE = `Картинка больше ${AGENT_IMAGE_MAX_BYTES / 1024} КБ. Выберите её на странице «Интерфейс» ещё раз — браузер уменьшит её сам.`;

export function imageTooLarge(message: string): AppError {
  return new AppError({ code: 'APP_AGENT_IMAGE_INVALID', message, userMessage: SIZE_MESSAGE, status: 413 });
}

export function checkAgentImage(bytes: Uint8Array): AgentImage {
  if (bytes.byteLength > AGENT_IMAGE_MAX_BYTES) throw imageTooLarge(`agent image is ${bytes.byteLength} bytes`);
  const type = imageTypeOf(bytes);
  if (!type) throw appError('APP_AGENT_IMAGE_INVALID', 'agent image is not PNG, JPEG or WebP', { userMessage: FORMAT_MESSAGE });
  return { bytes, type, sha256: createHash('sha256').update(bytes).digest('hex') };
}
