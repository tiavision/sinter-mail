// mail.parse's phases on their first call in Chromium (parser, cascade, then the whole parse once they ran):
// `node bench/tools/phases-browser.mjs [sinter-mail folder]`.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { bundle, PKG } from '../bundle.mjs';
import { newsletterHtml } from '../newsletter.mjs';
const pkg = process.argv[2] ?? PKG;
const b = await bundle(null, { code: `export { parseHTML, resolveStyles } from '${pkg}/sinter/engine.ts'; export { parse } from '${pkg}/sinter/parse.ts';` });
const html = newsletterHtml();
const server = createServer((req, res) => { if (req.url === '/p.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(readFileSync(b.path)); } res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>p</title>'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const rows = [];
for (let i = 0; i < 9; i++) {
  const p = await browser.newPage(); await p.goto(`http://127.0.0.1:${server.address().port}/`);
  rows.push(await p.evaluate(async (html) => {
    const m = await import('/p.js');
    const t0 = performance.now(); const root = m.parseHTML(html);
    const t1 = performance.now(); m.resolveStyles(root, { media: 'wide' });
    const t2 = performance.now(); m.parse(html + '<!---->'); const t3 = performance.now();
    return { parser: t1 - t0, cascade: t2 - t1, thenWholeParse: t3 - t2 };
  }, html));
  await p.close();
}
await browser.close(); server.close();
const med = (k) => [...rows.map((r) => r[k])].sort((a, b) => a - b)[4].toFixed(1);
console.log(`cold, Chromium: parser ${med('parser')} ms, cascade ${med('cascade')} ms; then mail.parse (parser and cascade warmed once) ${med('thenWholeParse')} ms`);
