// The tree page in Chromium with its console and errors printed: `node bench/tools/debug.mjs [base|work|ref]`.
import { chromium } from 'playwright';
import { buildApp, serve, page } from '../apps.mjs';
import { bundle } from '../bundle.mjs';
import { newsletterHtml } from '../newsletter.mjs';
const which = process.argv[2] ?? 'work';
const { parse } = await import((await bundle('sinter/parse.ts', { minify: false })).path);
const api = JSON.stringify(parse(newsletterHtml()));
const a = await buildApp({ 'index.html': page('<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n<main><mail-body id="message" data-sn-prop="{ body: message }"></mail-body></main>') }, { sinter: which, minify: false });
const s = await serve(a.dist, () => api);
const b = await chromium.launch(); const p = await b.newPage();
p.on('console', (m) => console.log('console', m.type(), m.text().slice(0, 300)));
p.on('pageerror', (e) => console.log('pageerror', e.message, e.stack?.slice(0, 500)));
await p.goto(s.url); await p.waitForTimeout(3000);
console.log('elements', await p.evaluate(() => document.querySelectorAll('#message *').length), 'first td span', await p.evaluate(() => document.querySelector('#message td span')?.textContent));
await b.close(); s.close(); console.log(a.dist);
