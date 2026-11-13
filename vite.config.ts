import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

// Hosts that can't send HTTP security headers (GitHub Pages) get the
// Content-Security-Policy as a <meta> tag. Build only: the dev server needs
// inline scripts for hot reload. Vercel also sends it as a header (vercel.json).
const CSP =
  "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: blob: https://*.supabase.co; " +
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://challenges.cloudflare.com; " +
  "base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests";

function cspMeta(): Plugin {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <meta name="referrer" content="strict-origin-when-cross-origin" />`),
  };
}

export default defineConfig({
  // GitHub Pages serves the site from /<repo-name>/; set BASE_PATH there.
  base: process.env.BASE_PATH || '/',
  plugins: [react(), cspMeta()],
  build: {
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
