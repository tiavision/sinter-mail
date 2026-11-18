// one warm switch of a variant, profiled: what runs between the API's answer and the paint, in time order
import { chromium } from 'playwright';
import { buildApp, serve, page, CSP, CALEY_CSP } from '../apps.mjs';
import { bundle } from '../bundle.mjs';
import { newsletterHtml } from '../newsletter.mjs';
import { VARIANTS } from '../variants.mjs';
const [name] = process.argv.slice(2);
const [base, which] = name.split('@');
const ctx = { html: newsletterHtml(), htmlOf: (n) => newsletterHtml(67, (n - 1) * 1000), page, CSP, CALEY_CSP, bundle, messages: 8,
  src: '/api/message?n={$url.n}', nav: '<nav><a id="next" data-sn-attr="{ href: \'?n=\' + (+$url.n + 1) }">next</a></nav>' };
const setup = await VARIANTS[base].setup(ctx);
const app = await buildApp(setup.files, { ...setup.build, minify: false, ...(which ? { sinter: which } : {}) });
const server = await serve(app.dist, setup.api, CSP);
const b = await chromium.launch(); const p = await b.newPage();
await p.addInitScript(() => { window.__marks = []; new MutationObserver(() => { window.__last = performance.now(); }).observe(document, { subtree: true, childList: true, attributes: true }); });
await p.goto(server.url + '?n=1');
const wait = (n) => p.waitForFunction((f) => document.querySelector('#message td span')?.textContent === f, String((n - 1) * 1000));
await wait(1);
for (let n = 2; n <= 6; n++) { await p.click('#next'); await wait(n); await p.waitForTimeout(150); }
const cdp = await p.context().newCDPSession(p);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 100 }); await cdp.send('Profiler.start');
const t0 = await p.evaluate(() => performance.now());
await p.click('#next'); await wait(7); await p.waitForTimeout(300);
const { profile } = await cdp.send('Profiler.stop');
const times = await p.evaluate(() => { const api = performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/message')).pop(); return { api: api.responseEnd, last: window.__last }; });
// samples on the page's clock: profile.startTime is in µs on the same monotonic clock as performance.now() + timeOrigin; align by the first sample near t0
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const origin = await p.evaluate(() => performance.timeOrigin);
let t = t0; // the profile started just before t0 (within a millisecond or two): samples on the page clock from there
const buckets = [];
for (let i = 0; i < profile.samples.length; i++) {
  t += profile.timeDeltas[i] / 1000;
  const stack = []; for (let id = profile.samples[i]; id !== undefined; id = parent.get(id)) { const f = byId.get(id).callFrame; if (f.functionName || f.url) stack.push(f.functionName || '(anon)'); }
  buckets.push([t, stack.slice(0, 6).join(' < ')]);
}
// align: the last sample in the render (reconcile, instantiate, make, walk on the stack) is the last change
const inRender = buckets.filter(([, k]) => /reconcile|instantiate|replaceChildren|walk/.test(k));
const shift = times.last - inRender[inRender.length - 1][0];
for (const x of buckets) x[0] += shift;
console.log('api answer', times.api.toFixed(1), 'last change', times.last.toFixed(1), 'first sample', buckets[0][0].toFixed(1));
// 2 ms slices from the answer to 40 ms after the last change: the most frequent stack top
if (process.env.SLICES) for (let s = times.api - 2; s < times.last + 40; s += 2) {
  const inSlice = buckets.filter(([x]) => x >= s && x < s + 2).map(([, k]) => k);
  const top = new Map(); for (const k of inSlice) top.set(k.split(' < ')[0] + ' < ' + (k.split(' < ')[1] ?? ''), (top.get(k.split(' < ')[0] + ' < ' + (k.split(' < ')[1] ?? '')) ?? 0) + 1);
  const best = [...top].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} (${v})`).join(' | ');
  console.log(`${(s - times.api).toFixed(0).padStart(4)} ms  ${String(inSlice.length).padStart(3)}  ${best}`);
}
await b.close(); server.close(); app.remove();
// self time in the window from the answer to the last change, by function
const self = new Map(); let total = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const [x] = buckets[i]; if (x < times.api || x > times.last + 1) continue;
  const f = byId.get(profile.samples[i]).callFrame; const k = `${f.functionName || '(anon)'}:${f.lineNumber + 1}`;
  const d = profile.timeDeltas[i + 1] ?? 100; self.set(k, (self.get(k) ?? 0) + d); total += d;
}
console.log(`window self time ${(total / 1000).toFixed(1)} ms`);
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`${(v / 1000).toFixed(2).padStart(6)}  ${k}`);
