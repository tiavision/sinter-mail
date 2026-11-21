// A tree that grows in place, as a stream would grow it: the API answers with the first HEAD nodes (in document
// order); the page then appends the rest to the live tree, STEP nodes per task, and tells sinter which objects
// changed (`app.changed`, the spike's identity pass; `?noid`: the whole page forced, today's cost for an
// in-place change). Per step: script (the flush) and style + layout; and the final DOM against a plain render.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFiles, page, launch, newsletter, elements } from './harness.mjs';
const [N = '2000', HEAD = '200', STEP = '400', runs = '5'] = process.argv.slice(2);
const full = newsletter(+N), COUNT = full.children.flatMap((c) => [...elements(c)]).length;
// the first HEAD nodes in document order, as copies with their children cut there
function prune(body, head) {
  let n = 0;
  const copy = (x) => { n++; if (x.type !== 'element') return { ...x }; const c = { ...x, children: [] }; for (const k of x.children) { if (n >= head) break; c.children.push(copy(k)); } return c; };
  const out = { ...body, children: [] };
  for (const k of body.children) { if (n >= head) break; out.children.push(copy(k)); }
  return out;
}
const MSG = { full: JSON.stringify(full), head: JSON.stringify(prune(full, +HEAD)) };
const a = await buildFiles({
  'index.html': page('<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n<main><mail-body id="message" data-sn-with="{ body: message }"></mail-body></main>\n<script type="module" src="/src/expose.ts"></script>'),
  'src/expose.ts': "import { instance } from '@tiaforge-ui/sinter';\n(window as any).__sn = () => instance(document);\n",
});
let cur = 'head';
const dir = join(a.root, 'dist');
const s = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/api/message') { res.setHeader('Content-Type', 'application/json'); return res.end(MSG[cur]); }
  if (p === '/api/full') { res.setHeader('Content-Type', 'application/json'); return res.end(MSG.full); }
  try { const b = readFileSync(join(dir, p === '/' ? 'index.html' : p)); res.setHeader('Content-Type', p.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(b); } catch { res.statusCode = 404; res.end(); }
});
await new Promise((r) => s.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${s.address().port}/`;
const b = await launch();
const grow = (step) => (async () => {
  const app = window.__sn();
  const live = app.page.$r.message;
  const full = await (await fetch('/api/full')).json();
  const order = [], parent = [];
  for (const st = [...full.children].reverse().map((c) => [c, -1]); st.length;) {
    const [n, p] = st.pop(); const i = order.length; order.push(n); parent.push(p);
    if (n.type === 'element') for (let k = n.children.length; k--;) st.push([n.children[k], i]);
  }
  const L = [];
  for (const st = [...live.children].reverse(); st.length;) { const n = st.pop(); L.push(n); if (n.type === 'element') for (let k = n.children.length; k--;) st.push(n.children[k]); }
  const steps = []; const t0 = performance.now();
  for (let i = L.length; i < order.length;) {
    const changed = new Set();
    for (const end = Math.min(order.length, i + step); i < end; i++) {
      const f = order[i], copy = f.type === 'element' ? { ...f, children: [] } : { ...f };
      (parent[i] < 0 ? live : L[parent[i]]).children.push(copy);
      L[i] = copy;
      for (let p = parent[i]; p >= 0; p = parent[p]) changed.add(L[p]);
      changed.add(live);
    }
    const a0 = performance.now(); app.changed(...changed); app.flush();
    const a1 = performance.now(); document.body.offsetHeight;
    const a2 = performance.now();
    steps.push([a1 - a0, a2 - a1]);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
  }
  return { steps, total: performance.now() - t0, misses: app.idMisses };
}).toString().replace('async () =>', `async (step = ${step}) =>`);
const res = { id: [], noid: [] }; let dom = {};
for (let r = 0; r < +runs; r++) for (const v of ['id', 'noid']) {
  cur = 'head';
  const p = await b.newPage();
  await p.goto(url + (v === 'noid' ? '?noid' : ''));
  await p.waitForFunction(() => document.querySelectorAll('#message *').length > 0 && (window).__sn);
  await p.waitForTimeout(100);
  res[v].push(await p.evaluate(`(${grow(+STEP)})()`));
  if (r === 0) dom[v] = await p.evaluate(() => [document.querySelectorAll('#message *').length, document.querySelector('#message').innerHTML.replace(/<!--[^>]*-->/g, '')]);
  await p.close();
}
// the same email rendered whole from the API, for the DOM comparison
cur = 'full';
{ const p = await b.newPage(); await p.goto(url); await p.waitForFunction((n) => document.querySelectorAll('#message *').length === n, COUNT); dom.plain = await p.evaluate(() => [document.querySelectorAll('#message *').length, document.querySelector('#message').innerHTML.replace(/<!--[^>]*-->/g, '')]); await p.close(); }
const med = (x) => { const v = [...x].sort((p, q) => p - q); return v[v.length >> 1]; };
console.log(`${COUNT} elements; head ${HEAD} nodes, then ${STEP} nodes per step; ${runs} runs each, medians`);
for (const v of ['id', 'noid']) {
  const rs = res[v], k = rs[0].steps.length;
  const js = Array.from({ length: k }, (_, i) => med(rs.map((r) => r.steps[i][0]))), lay = Array.from({ length: k }, (_, i) => med(rs.map((r) => r.steps[i][1])));
  console.log(`  ${(v === 'id' ? 'identity pass' : 'forced (today)').padEnd(15)} steps ${k}; script per step ${js.map((x) => x.toFixed(1)).join(' ')} ms; style+layout per step ${lay.map((x) => x.toFixed(1)).join(' ')} ms; script total ${js.reduce((p, q) => p + q, 0).toFixed(0)} ms; wall ${med(rs.map((r) => r.total)).toFixed(0)} ms; misses ${rs[0].misses}`);
}
console.log('  final DOM equals a plain render: identity', dom.id[1] === dom.plain[1], `(${dom.id[0]}/${dom.plain[0]} elements), forced`, dom.noid[1] === dom.plain[1]);
await b.close(); s.close(); a.remove();
