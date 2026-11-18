import { buildApi, serve, launch, newsletter, elements } from './harness.mjs';
const BIG = newsletter(2000), MSG = JSON.stringify(BIG);
const COUNT = BIG.children.flatMap((c) => [...elements(c)]).length;
const a = await buildApi(); const srv = await serve(a.root + '/dist', () => MSG);
const b = await launch(); const p = await b.newPage();
await p.addInitScript(() => { window.__c = {}; const P = CSSStyleDeclaration.prototype; for (const m of ['setProperty', 'removeProperty']) { const o = P[m]; P[m] = function (...x) { window.__c[m] = (window.__c[m] ?? 0) + 1; return o.apply(this, x); }; }
  const d = Object.getOwnPropertyDescriptor(P, 'cssText'); Object.defineProperty(P, 'cssText', { ...d, set(v) { window.__c.cssText = (window.__c.cssText ?? 0) + 1; d.set.call(this, v); } }); });
await p.goto(srv.url);
await p.waitForFunction((n) => document.querySelectorAll('#message *').length === n, COUNT, { polling: 50 });
console.log(COUNT, 'elements', await p.evaluate(() => window.__c), 'styled elements', await p.evaluate(() => document.querySelectorAll('#message [style]').length));
await b.close(); srv.close(); a.remove();
