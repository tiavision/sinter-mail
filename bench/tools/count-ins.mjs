// Counts sinter's template instantiations in one render of the newsletter, by kind (anchor, text, clone) and
// template: `node bench/tools/count-ins.mjs <dist>`, where <dist> is a build of the tree page whose bundle
// was patched to count calls into globalThis.__ins (an unminified build; see the report).
import { chromium } from 'playwright';
import { serve } from '../apps.mjs';
import { bundle } from '../bundle.mjs';
import { newsletterHtml } from '../newsletter.mjs';
const b = await bundle('sinter/parse.ts', { minify: false });
const { parse } = await import(b.path);
const api = JSON.stringify(parse(newsletterHtml()));
const s = await serve(process.argv[2], () => api);
const br = await chromium.launch(); const p = await br.newPage();
await p.goto(s.url); await p.waitForFunction(() => document.querySelectorAll('#message *').length > 2000); await p.waitForTimeout(300);
const ins = await p.evaluate(() => globalThis.__ins);
const tot = Object.values(ins).reduce((a, b) => a + b, 0);
const by = {}; for (const [k, v] of Object.entries(ins)) { const kind = k.split(':')[0]; by[kind] = (by[kind] ?? 0) + v; }
console.log('instantiate calls', tot, by);
console.log(Object.entries(ins).sort((a, b) => b[1] - a[1]).slice(0, 12));
await br.close(); s.close();
