// Where a variant's time goes in Chromium: the page's CDP Performance metrics over the whole load (script,
// style recalculation, layout), and a sampling CPU profile's functions by self time, unminified build.
//
//   node bench/profile.mjs <variant> [--top 25]
import { chromium } from 'playwright';
import { buildApp, serve, page, CSP, CALEY_CSP } from './apps.mjs';
import { bundle } from './bundle.mjs';
import { newsletterHtml } from './newsletter.mjs';
import { VARIANTS } from './variants.mjs';

const [name, ...rest] = process.argv.slice(2);
const top = rest[0] === '--top' ? Number(rest[1]) : 25;
const ctx = { html: newsletterHtml(), htmlOf: (n) => newsletterHtml(67, (n - 1) * 1000), page, CSP, CALEY_CSP, bundle, src: '/api/message', nav: '' };
const [base, which] = name.split('@');
const setup = await VARIANTS[base].setup(ctx);
const app = await buildApp(setup.files, { ...setup.build, minify: false, ...(which ? { sinter: which } : {}) });
const server = await serve(app.dist, typeof setup.api === 'function' ? setup.api : () => setup.api, setup.csp ?? CSP);
const browser = await chromium.launch();
const results = [];
for (let i = 0; i < 4; i++) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Performance.enable');
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  await cdp.send('Profiler.start');
  await p.goto(server.url);
  await p.waitForFunction(setup.done, setup.expect, { polling: 50, timeout: 30_000 });
  await p.waitForTimeout(300);
  const { profile } = await cdp.send('Profiler.stop');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  results.push({ profile, m });
  await p.close();
}
await browser.close();
server.close();
if (!process.env.KEEP) app.remove(); else console.log("kept", app.dist);

// metrics: the median run by TaskDuration
results.sort((a, b) => a.m.TaskDuration - b.m.TaskDuration);
const { profile, m } = results[Math.floor(results.length / 2)];
const ms = (s) => `${(s * 1000).toFixed(1)} ms`;
console.log(`${name}: task ${ms(m.TaskDuration)}, script ${ms(m.ScriptDuration)}, style ${ms(m.RecalcStyleDuration)} (${m.RecalcStyleCount}), layout ${ms(m.LayoutDuration)} (${m.LayoutCount}), nodes ${m.Nodes}`);

// self time by function
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = profile.timeDeltas;
for (let i = 0; i < profile.samples.length; i++) {
  const n = byId.get(profile.samples[i]);
  const f = n.callFrame;
  const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log(`profile: ${(total / 1000).toFixed(1)} ms sampled`);
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${(v / 1000).toFixed(1).padStart(7)} ms  ${k}`);

// inclusive time by function (a function counted once per sample however deep it recurses)
if (process.env.INCLUSIVE) {
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const incl = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const seen = new Set();
    for (let id = profile.samples[i]; id !== undefined; id = parent.get(id)) {
      const f = byId.get(id).callFrame;
      if (!f.url) continue;
      const key = `${f.functionName || '(anonymous)'} :${f.lineNumber + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      incl.set(key, (incl.get(key) ?? 0) + (dt[i] ?? 0));
    }
  }
  console.log('inclusive:');
  for (const [k, v] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.INCLUSIVE))) console.log(`${(v / 1000).toFixed(1).padStart(7)} ms  ${k}`);
}
