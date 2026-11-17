// mail.parse in Chromium: the bundle as a page gets it (Vite, minified), loaded in a fresh tab, timed on its
// first call (cold: functions compiled lazily, interpreted, then tiered up) and on later calls, with and
// without a warm-up on a small email first (the corpus newsletter, 3.6 kB).
//
//   node bench/parse-browser.mjs [--tabs 7]
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bundle, PKG } from './bundle.mjs';
import { newsletterHtml } from './newsletter.mjs';

const tabs = Number(process.argv[process.argv.indexOf('--tabs') + 1]) || 7;
const pkg = process.env.PKG ?? PKG;
const b = await bundle(null, { code: `export { parse } from '${pkg}/sinter/parse.ts';` });
const big = newsletterHtml(), small = readFileSync(join(PKG, 'test/corpus/newsletter.html'), 'utf8');
const server = createServer((req, res) => {
  if (req.url === '/p.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(readFileSync(b.path)); }
  res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>p</title>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const rows = { cold: [], warmed: [] };
for (let i = 0; i < tabs; i++) {
  for (const mode of ['cold', 'warmed']) {
    const p = await browser.newPage();
    await p.goto(url);
    const t = await p.evaluate(async ({ big, small, mode }) => {
      const { parse } = await import('/p.js');
      const out = { warmup: 0, calls: [] };
      if (mode === 'warmed') { const t0 = performance.now(); for (let k = 0; k < 3; k++) parse(small + k); out.warmup = performance.now() - t0; await new Promise((r) => setTimeout(r, 50)); }
      for (let k = 0; k < 5; k++) { const t0 = performance.now(); parse(big + `<!--${k}-->`); out.calls.push(performance.now() - t0); }
      return out;
    }, { big, small, mode });
    rows[mode].push(t);
    await p.close();
  }
}
await browser.close(); server.close();
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const mode of ['cold', 'warmed']) {
  const r = rows[mode];
  console.log(`${mode.padEnd(7)} ${mode === 'warmed' ? `warm-up (3 × 3.6 kB) ${med(r.map((x) => x.warmup)).toFixed(1)} ms; ` : ''}1st ${med(r.map((x) => x.calls[0])).toFixed(1)} ms, 2nd ${med(r.map((x) => x.calls[1])).toFixed(1)} ms, 5th ${med(r.map((x) => x.calls[4])).toFixed(1)} ms (medians of ${tabs} tabs)`);
}
