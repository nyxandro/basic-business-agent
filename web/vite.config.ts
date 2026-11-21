import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// Development: the page is served on the address from APP_PUBLIC_URL (.env.example: port 8080),
// the server API is proxied to the app (core/server/main.ts listens on 3000). In production
// Caddy serves the built files and passes only /app/api to the app (spec, section 17.1).
const DEV_PORT = 8080;
const APP_SERVER = 'http://localhost:3000';

// The files PDF.js reads besides the document (src/viewer/pdfjs.ts, spec section 8.27): fonts and maps
// for PDFs without their fonts, decoders of scanned pictures. Served at /pdfjs/ while developing and
// copied into the build — the same version as the package, never kept in the repository.
const PDFJS_ROOT = fileURLToPath(new URL('./node_modules/pdfjs-dist', import.meta.url));
const PDFJS_FOLDERS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
const PDFJS_TYPES: Record<string, string> = { '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.icc': 'application/vnd.iccprofile' };

function pdfjsAssets(): Plugin {
  return {
    name: 'bba-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? '').split('?')[0]!)).replace(/^[/\\]+/, '');
        const path = join(PDFJS_ROOT, rel);
        if (!PDFJS_FOLDERS.includes(rel.split(sep)[0]!) || !path.startsWith(PDFJS_ROOT + sep) || !existsSync(path) || !statSync(path).isFile()) return next();
        res.setHeader('content-type', PDFJS_TYPES[extname(path)] ?? 'application/octet-stream');
        createReadStream(path).pipe(res);
      });
    },
    writeBundle(options) {
      for (const folder of PDFJS_FOLDERS) cpSync(join(PDFJS_ROOT, folder), join(options.dir!, 'pdfjs', folder), { recursive: true });
    },
  };
}

// The browser's handler of notifications (src/sw/sw.ts, docs/specs/[20.11.2026]-notifications.md): it must sit at
// /sw.js — a handler controls only addresses under its own — and keep that name, so the build makes it a separate
// entry without a hash; while developing it is served from its source. It has no imports, so either way it is one
// plain script.
const WORKER_ENTRY = fileURLToPath(new URL('./src/sw/sw.ts', import.meta.url));
const WORKER_PATH = '/sw.js';

function notificationWorker(): Plugin {
  return {
    name: 'bba-notification-worker',
    configureServer(server) {
      server.middlewares.use(WORKER_PATH, (req, res, next) => {
        if ((req.url ?? '/').split('?')[0] !== '/') return next();
        server
          .transformRequest('/src/sw/sw.ts')
          .then((result) => {
            if (!result) return next();
            res.setHeader('content-type', 'text/javascript; charset=utf-8');
            res.setHeader('cache-control', 'no-cache');
            res.end(result.code);
          })
          .catch(next);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsAssets(), notificationWorker()],
  build: {
    rolldownOptions: {
      input: { index: fileURLToPath(new URL('./index.html', import.meta.url)), sw: WORKER_ENTRY },
      output: { entryFileNames: (chunk) => (chunk.name === 'sw' ? WORKER_PATH.slice(1) : 'assets/[name]-[hash].js') },
    },
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    proxy: { '/app/api': { target: APP_SERVER } },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
