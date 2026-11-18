// Message after message in one page, warm: the page shows message 1, then follows a link to the next
// message `--switches` times (sinter's in-page navigation, no page load), each a new email of the same
// shape (its items numbered from (n - 1) × 1000). Per switch: from the API's answer to the page's last change
// (the script: the JSON, mail.parse for the HTML variants, the render) and to the frame painted after it.
// Medians over the switches, the first two left out (the JIT warming up). Lower noise than bench/browser.mjs,
// for comparing changes to the render: one tab, no page load, warm code.
//
//   node bench/switch.mjs <variant ...> [--switches 20]
import { join } from 'node:path';
import { chromium } from 'playwright';
import { buildApp, serve, page, CSP, CALEY_CSP, PKG } from './apps.mjs';
import { bundle } from './bundle.mjs';
import { newsletterHtml } from './newsletter.mjs';
import { VARIANTS } from './variants.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--switches');
const SWITCHES = at < 0 ? 20 : Number(args.splice(at, 2)[1]);
const N = SWITCHES + 1;
const ctx = {
  html: newsletterHtml(), htmlOf: (n) => newsletterHtml(67, (n - 1) * 1000), page, CSP, CALEY_CSP, bundle, messages: N,
  src: '/api/message?n={$url.n}', nav: '<nav><a id="next" data-sn-attr="{ href: \'?n=\' + (+$url.n + 1) }">next</a></nav>',
};
const browser = await chromium.launch();
for (const name of args) {
  const [head, which] = name.split('@');
  const [base, proto] = head.split('+');
  const setup = await VARIANTS[base].setup(ctx);
  const app = await buildApp(setup.files, { ...setup.build, ...(which ? { sinter: which } : {}), ...(proto ? { pkg: join(PKG, '..', `sm-${proto}`) } : {}) });
  const server = await serve(app.dist, setup.api, setup.csp ?? CSP);
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => {
    window.__painted = 0; window.__changed = 0;
    new MutationObserver(() => {
      const at = (window.__changed = performance.now());
      requestAnimationFrame(() => setTimeout(() => { if (window.__changed === at) window.__painted = performance.now(); }));
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await p.goto(server.url + '?n=1');
  const script = [], paint = [];
  for (let n = 1; n <= N; n++) {
    if (n > 1) await p.click('#next');
    const first = String((n - 1) * 1000);
    await p.waitForFunction((first) => {
      const r = document.querySelector('#message'), f = r?.querySelector('iframe');
      return (f ? f.contentDocument?.body : r)?.querySelector('td span')?.textContent === first;
    }, first, { polling: 20, timeout: 30_000 });
    await p.waitForFunction(() => window.__painted > window.__changed && performance.now() - window.__changed > 200, null, { polling: 20 });
    const [s, t] = await p.evaluate(() => {
      const api = performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/message')).pop();
      return [window.__changed - api.responseEnd, window.__painted - api.responseEnd];
    });
    if (n > 3) { script.push(s); paint.push(t); }
  }
  if (errors.length) throw new Error(`${name}: ${errors.join('\n')}`);
  await p.close(); server.close(); app.remove();
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`${name.padEnd(22)} to last change ${med(script).toFixed(1).padStart(6)} ms   to paint ${med(paint).toFixed(1).padStart(6)} ms   (${script.length} switches; script ${script.map((x) => x.toFixed(0)).join(' ')})`);
}
await browser.close();
