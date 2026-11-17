// Test helper: an S3-compatible service on this machine, enough of the protocol for the file storage
// (spec, section 8.23): objects put, read, removed and listed in one bucket, path-style addresses only.
// Signatures are not checked, only the access key named in them; `outage` makes every request fail.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeS3 {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  objects: Map<string, Buffer>;
  // Every request answers 503 while on.
  outage(on: boolean): void;
  // How many requests of each kind came («PUT», «GET», «DELETE», «LIST»).
  calls: Record<string, number>;
  close(): Promise<void>;
}

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function error(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'content-type': 'application/xml' }).end(xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`));
}

async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const PAGE = 1000;

export async function startFakeS3(options: { bucket?: string; accessKeyId?: string; pageSize?: number } = {}): Promise<FakeS3> {
  const bucket = options.bucket ?? 'bba-test';
  const accessKeyId = options.accessKeyId ?? 'test-access-key';
  const pageSize = options.pageSize ?? PAGE;
  const objects = new Map<string, Buffer>();
  const calls: Record<string, number> = {};
  let down = false;
  const count = (kind: string) => (calls[kind] = (calls[kind] ?? 0) + 1);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const [, name, ...rest] = url.pathname.split('/');
      const key = decodeURIComponent(rest.join('/'));
      if (down) return error(res, 503, 'ServiceUnavailable');
      if (!(req.headers.authorization ?? '').includes(`Credential=${accessKeyId}/`)) return error(res, 403, 'InvalidAccessKeyId');
      if (name !== bucket) return error(res, 404, 'NoSuchBucket');
      if (req.method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
        count('LIST');
        const prefix = url.searchParams.get('prefix') ?? '';
        const after = url.searchParams.get('continuation-token') ?? '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const page = keys.slice(0, pageSize);
        const truncated = keys.length > pageSize;
        const contents = page.map((k) => `<Contents><Key>${escape(k)}</Key><Size>${objects.get(k)!.length}</Size><LastModified>2026-11-17T00:00:00.000Z</LastModified><ETag>"e"</ETag><StorageClass>STANDARD</StorageClass></Contents>`).join('');
        const next = truncated ? `<NextContinuationToken>${escape(page.at(-1)!)}</NextContinuationToken>` : '';
        return res
          .writeHead(200, { 'content-type': 'application/xml' })
          .end(xml(`<ListBucketResult><Name>${bucket}</Name><Prefix>${escape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${pageSize}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`));
      }
      if (!key) return error(res, 400, 'InvalidRequest');
      if (req.method === 'PUT') {
        count('PUT');
        const data = await bodyOf(req);
        if (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) !== data.length) return error(res, 400, 'IncompleteBody');
        objects.set(key, data);
        return res.writeHead(200, { etag: '"e"' }).end();
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        count('GET');
        const data = objects.get(key);
        if (!data) return error(res, 404, 'NoSuchKey');
        res.writeHead(200, { 'content-length': String(data.length), 'content-type': 'application/octet-stream', etag: '"e"' });
        return req.method === 'HEAD' ? res.end() : res.end(data);
      }
      if (req.method === 'DELETE') {
        count('DELETE');
        objects.delete(key);
        return res.writeHead(204).end();
      }
      return error(res, 405, 'MethodNotAllowed');
    })().catch(() => error(res, 500, 'InternalError'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    accessKeyId,
    objects,
    outage: (on) => {
      down = on;
    },
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
