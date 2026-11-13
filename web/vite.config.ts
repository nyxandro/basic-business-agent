import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Development: the page is served on the address from APP_PUBLIC_URL (.env.example: port 8080),
// the server API is proxied to the app (core/server/main.ts listens on 3000). In production
// Caddy serves the built files and passes only /app/api to the app (spec, section 17.1).
const DEV_PORT = 8080;
const APP_SERVER = 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
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
