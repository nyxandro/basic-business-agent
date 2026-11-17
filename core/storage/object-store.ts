// An S3 bucket as the store of the workspace's files (spec, section 8.23). Any S3-compatible service:
// Yandex Object Storage, Selectel, VK Cloud, Cloud.ru, Timeweb, MinIO, Amazon. Checksums are sent only
// where the protocol requires them: the newer default of the SDK (CRC32 on every upload) is refused by
// several S3-compatible services. Objects are removed one by one for the same reason (DeleteObjects
// requires a checksum header some of them do not take).
import { randomUUID } from 'node:crypto';
import { createReadStream, fstatSync } from 'node:fs';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { AppError } from '../errors/app-error.ts';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  // Folder in the bucket, '' or ending with «/»: a bucket shared with other uses keeps our files apart.
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ObjectStore {
  readonly bucket: string;
  // Uploads an opened file from its start; the descriptor is closed when done.
  putFile(key: string, fd: number): Promise<{ bytes: number }>;
  putBytes(key: string, data: Uint8Array): Promise<void>;
  // The object's bytes as a stream, or null when there is no such object.
  get(key: string): Promise<Readable | null>;
  remove(key: string): Promise<void>;
  // Keys under the prefix (relative to the store's folder), for checks and clean-up.
  list(prefix: string): Promise<{ key: string; bytes: number }[]>;
  close(): void;
}

// A request that does not answer in this time counts as a failure of the service.
const REQUEST_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;

// The codes the service gives for a wrong key, a wrong bucket or no rights: the admin's to fix.
const ACCESS_CODES = new Set(['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied', 'Forbidden', 'AuthorizationHeaderMalformed', 'InvalidToken', 'ExpiredToken']);
const BUCKET_CODES = new Set(['NoSuchBucket', 'PermanentRedirect', 'IllegalLocationConstraintException']);

export function storageUnavailable(cause: unknown, operation: string): AppError {
  const code = cause instanceof S3ServiceException ? cause.name : (cause as NodeJS.ErrnoException | undefined)?.code;
  if (code && ACCESS_CODES.has(code)) {
    return new AppError({
      code: 'APP_STORAGE_ACCESS_DENIED',
      message: `S3 ${operation} refused: ${code}`,
      userMessage: 'Хранилище файлов отказало в доступе: ключ неверный, отозван или у него нет прав на этот бакет.',
      nextStep: 'Проверьте ключ доступа и его права в консоли провайдера и введите его заново в «Хранилище файлов».',
      status: 502,
      cause,
    });
  }
  if (code && BUCKET_CODES.has(code)) {
    return new AppError({
      code: 'APP_STORAGE_BUCKET_NOT_FOUND',
      message: `S3 ${operation}: bucket problem ${code}`,
      userMessage: 'Бакета с таким именем нет у этого провайдера или он в другом регионе.',
      nextStep: 'Проверьте имя бакета, регион и адрес сервиса.',
      status: 502,
      cause,
    });
  }
  return new AppError({
    code: 'APP_STORAGE_UNAVAILABLE',
    message: `S3 ${operation} failed: ${code ?? (cause instanceof Error ? cause.name : 'unknown')}`,
    userMessage: 'Хранилище файлов сейчас не отвечает — файлы недоступны.',
    nextStep: 'Попробуйте через минуту. Если повторяется — сообщите администратору код ошибки.',
    status: 503,
    cause,
  });
}

const isMissing = (error: unknown) => error instanceof S3ServiceException && (error.name === 'NoSuchKey' || error.name === 'NotFound' || error.$metadata.httpStatusCode === 404);

export function createObjectStore(config: S3Config): ObjectStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.pathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    // The SDK repeats a failed request itself (3 attempts with back-off) — its own documented policy.
    maxAttempts: 3,
    requestHandler: { requestTimeout: REQUEST_TIMEOUT_MS, connectionTimeout: CONNECT_TIMEOUT_MS },
  });
  const full = (key: string) => `${config.prefix}${key}`;
  const call = async <T>(operation: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw storageUnavailable(error, operation);
    }
  };

  return {
    bucket: config.bucket,
    async putFile(key, fd) {
      const bytes = fstatSync(fd).size;
      const body = createReadStream('', { fd, start: 0, autoClose: true });
      try {
        await call('put', () => client.send(new PutObjectCommand({ Bucket: config.bucket, Key: full(key), Body: body, ContentLength: bytes })));
      } finally {
        body.destroy();
      }
      return { bytes };
    },
    async putBytes(key, data) {
      await call('put', () => client.send(new PutObjectCommand({ Bucket: config.bucket, Key: full(key), Body: data, ContentLength: data.byteLength })));
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: full(key) }));
        if (!out.Body) return null;
        return out.Body as Readable;
      } catch (error) {
        if (isMissing(error)) return null;
        throw storageUnavailable(error, 'get');
      }
    },
    async remove(key) {
      await call('delete', () => client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: full(key) })));
    },
    async list(prefix) {
      const out: { key: string; bytes: number }[] = [];
      let token: string | undefined;
      do {
        const page = await call('list', () => client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: full(prefix), ContinuationToken: token })));
        for (const o of page.Contents ?? []) if (o.Key) out.push({ key: o.Key.slice(config.prefix.length), bytes: o.Size ?? 0 });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    close() {
      client.destroy();
    },
  };
}

// «Проверить»: a small object written, read back, listed and removed — every right the files need.
export async function checkObjectStore(store: ObjectStore): Promise<void> {
  const key = `.bba-check/${randomUUID()}`;
  const data = new TextEncoder().encode('bba storage check');
  await store.putBytes(key, data);
  try {
    const stream = await store.get(key);
    if (!stream) throw storageUnavailable(new Error('written object is not readable'), 'check');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    if (!Buffer.concat(chunks).equals(Buffer.from(data))) throw storageUnavailable(new Error('object read back differs'), 'check');
    const listed = await store.list('.bba-check/');
    if (!listed.some((o) => o.key === key)) throw storageUnavailable(new Error('written object is not listed'), 'check');
  } finally {
    await store.remove(key);
  }
}
