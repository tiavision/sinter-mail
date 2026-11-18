import { buildApi, serve, launch, newsletter, elements } from './harness.mjs';
import { readFileSync } from 'node:fs';
const PKG = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { progressive } = await import(PKG + '/sinter/tree.ts');
const [runs = '15', N = '2000', head = '200', src = 'gen', vs = 'plain:,prog:step=400,prog:step=100000,plain:deep,prog:deep&step=400'] = process.argv.slice(2);
const VARIANTS = vs.split(',');
const make = () => (src === 'gen' ? newsletter(+N) : JSON.parse(readFileSync(src, 'utf8')));
const plainTree = make();
const COUNT = plainTree.children.flatMap((c) => [...elements(c)]).length;
const MSG = { plain: JSON.stringify(plainTree), prog: JSON.stringify(progressive(make(), +head)) };
let cur = 'plain';
// plain: <mail-body> with the tree as it is; prog: <mail-body-progressive> with the numbered tree
const a = await buildApi(); const srv = await serve(a.root + '/dist', () => MSG[cur]);
const ap = await buildApi('<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n<main><mail-body-progressive id="message" data-sn-prop="{ body: message }"></mail-body-progressive></main>');
const srvp = await serve(ap.root + '/dist', () => MSG[cur]);
const b = await launch();
const INIT = () => {
  window.__last = 0; window.__long = 0; let prev = 0; const f = (t) => { if (prev && window.__api) window.__long = Math.max(window.__long, t - prev); prev = t; requestAnimationFrame(f); }; requestAnimationFrame(f);
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name.endsWith('/api/message')) window.__api = 1; }).observe({ type: 'resource' });
  new MutationObserver(() => { window.__last = performance.now(); }).observe(document, { subtree: true, childList: true, attributes: true });
  
};
const res = Object.fromEntries(VARIANTS.map((v) => [v, []])); const doms = {};
for (let r = 0; r < +runs; r++) for (const v of VARIANTS) {
  const [tree, q] = v.split(':'); cur = tree;
  const p = await b.newPage(); await p.addInitScript(INIT);
  await p.goto((tree === 'prog' ? srvp : srv).url + (q ? '?' + q : ''));
  await p.waitForFunction((n) => document.querySelectorAll('#message *').length === n, COUNT, { polling: 50 });
  await p.waitForTimeout(200);
  res[v].push(await p.evaluate(() => {
    const api = performance.getEntriesByType('resource').find((e) => e.name.endsWith('/api/message'));
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return { first: fcp.startTime - api.responseEnd, all: __last - api.responseEnd, long: __long };
  }));
  if (r === 0) doms[v] = await p.evaluate(() => document.querySelector('#message').innerHTML.replace(/<!--[^>]*-->/g, ''));
  await p.close();
}
const med = (x) => { const s = [...x].sort((p, q) => p - q); return s[s.length >> 1].toFixed(1); };
console.log(`${COUNT} elements, ${MSG.plain.length} B JSON plain, ${MSG.prog.length} B progressive (head ${head}), ${runs} runs each, interleaved; medians in ms`);
for (const v of VARIANTS) console.log(`  ${v.padEnd(22)} first paint of the email ${med(res[v].map((x) => x.first)).padStart(6)}   all rendered ${med(res[v].map((x) => x.all)).padStart(6)}   longest frame gap ${med(res[v].map((x) => x.long)).padStart(6)}`);
console.log('  final DOM identical:', Object.values(doms).every((d) => d === Object.values(doms)[0]));
await b.close(); srv.close(); a.remove(); srvp.close(); ap.remove();
