// Shared harness: build an API page that renders a mail tree, serve it, measure in Chromium.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const PKG = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { build } = await import(join(PKG, 'node_modules/vite/dist/node/index.js'));
const sinter = (await import(join(PKG, 'node_modules/@tiaforge-ui/sinter/dist/vite.js'))).default;
const { chromium } = await import(join(PKG, 'node_modules/playwright/index.mjs'));
const A = await import(join(PKG, 'test/app.ts'));
export const { app, page, newsletter, elements } = A;

export async function buildApi(body = '<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n<main><mail-body id="message" data-sn-prop="{ body: message }"></mail-body></main>') {
  const a = app({ 'index.html': page(body) });
  await build({ root: a.root, logLevel: 'silent', plugins: [sinter({ components: ['@tiavision/sinter-mail'] })], build: { outDir: join(a.root, 'dist'), emptyOutDir: true, minify: !process.env.NOMIN } });
  return a;
}
export function serve(dir, getMessage) {
  const s = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/message') { res.setHeader('Content-Type', 'application/json'); return res.end(getMessage()); }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    try { const b = readFileSync(join(dir, path)); res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(b); }
    catch { res.statusCode = 404; res.end(); }
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${s.address().port}/`, close: () => s.close() })));
}
export const launch = () => chromium.launch();
// instrumentation: time of last DOM mutation, and first/last paint-ish via rAF after mutations
export const INIT = () => {
  window.__last = 0; window.__first = 0;
  new MutationObserver(() => { const t = performance.now(); if (!window.__first) window.__first = t; window.__last = t; })
    .observe(document, { subtree: true, childList: true, attributes: true });
};
/** an app from a files map (index.html and any src/ files), built with sinter-mail's components */
export async function buildFiles(files) {
  const a = app(files);
  await build({ root: a.root, logLevel: 'silent', plugins: [sinter({ components: ['@tiavision/sinter-mail'] })], build: { outDir: join(a.root, 'dist'), emptyOutDir: true, minify: !process.env.NOMIN } });
  return a;
}
