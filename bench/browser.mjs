// The browser benchmark: each variant's page in Chromium (Playwright), its API answering the newsletter of
// bench/newsletter.mjs, and the time from the API's answer to the frame painted after the page's last change.
//
//   node bench/browser.mjs [variant ...] [--runs 7] [--blocks 67]
//
// Method, per run: a fresh tab loads the page; a MutationObserver (installed before the page's scripts)
// stamps, after each batch of changes, the end of the next frame (requestAnimationFrame, then a task: the
// frame has been painted); once the element count is reached and nothing changed for 300 ms, the result is
// that stamp minus the API response's responseEnd (Resource Timing). The median of `runs` runs (after one
// run discarded to warm the server and the browser's cache of the page's files) is printed, with every run.
// Each page's JavaScript is every .js file of its build, gzip level 9, the size of the page module and
// what it imports; a lazy chunk is listed on its own.
//
// Chromium only (the one browser in these sessions); the numbers are one machine's, compare them with each
// other, not across machines.
import { chromium } from 'playwright';
import { join } from 'node:path';
import { buildApp, serve, page, CSP, CALEY_CSP, PKG } from './apps.mjs';
import { bundle } from './bundle.mjs';
import { newsletterHtml } from './newsletter.mjs';
import { VARIANTS } from './variants.mjs';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return Number(v); };
const RUNS = opt('--runs', 7);
const BLOCKS = opt('--blocks', 67);
const chosen = args.length ? args : Object.keys(VARIANTS).filter((k) => !VARIANTS[k].optional);

const SECOND = args.includes('--second') ? (args.splice(args.indexOf('--second'), 1), true) : false;
const HTML = newsletterHtml(BLOCKS);
// message n numbers its items from (n - 1) × 1000: the second message is another email of the same shape
const htmlOf = (n) => newsletterHtml(BLOCKS, (n - 1) * 1000);
// with --second, each page reads the message number from its URL and links to the next message (which
// brings sinter's in-page navigation into the page module: first-load sizes are measured without it)
const nav = SECOND ? { src: '/api/message?n={$url.n}', nav: '<nav><a id="next" href="?n=2">next</a></nav>' } : { src: '/api/message', nav: '' };
const ctx = { html: HTML, htmlOf, page, CSP, CALEY_CSP, bundle, ...nav };

const browser = await chromium.launch();

// build and serve every variant first, then run them round-robin (one run of each per round, the order
// rotating), so that a slower minute of the machine falls on every variant alike
const vs = [];
for (const name of chosen) {
  // `name@work`: the variant built with the research branch of sinter (bench/apps.mjs, SINTERS);
  // `name+x`: with the sinter-mail prototype in ../sm-x (a worktree of this repository)
  const [head, which] = name.split('@');
  const [base, proto] = head.split('+');
  const v = VARIANTS[base];
  if (!v) { console.error(`no variant ${base}; variants: ${Object.keys(VARIANTS).join(', ')}`); process.exit(1); }
  const setup = await v.setup(ctx);
  const app = await buildApp(setup.files, { ...setup.build, ...(which ? { sinter: which } : {}), ...(proto ? { pkg: join(PKG, '..', `sm-${proto}`) } : {}) });
  const server = await serve(app.dist, typeof setup.api === 'function' ? setup.api : () => setup.api, setup.csp ?? CSP);
  vs.push({ name, v, setup, app, server, times: [], count: 0 });
}

async function run(x) {
  const { setup, server, name } = x;
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.violatedDirective} ${e.sample}`));
    window.__painted = 0;
    window.__changed = 0;
    new MutationObserver(() => {
      const at = (window.__changed = performance.now());
      requestAnimationFrame(() => setTimeout(() => { if (window.__changed === at) window.__painted = performance.now(); }));
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await p.goto(server.url + '?n=1');
  const settle = async (first) => {
    await p.waitForFunction(setup.done, setup.expect, { polling: 50, timeout: 30_000 });
    // the message's first item is the one expected (the second message's: 1000)
    if (setup.expect) await p.waitForFunction((first) => {
      const r = document.querySelector('#message'), f = r?.querySelector('iframe');
      return (f ? f.contentDocument?.body : r)?.querySelector('td span')?.textContent === String(first);
    }, first, { polling: 50, timeout: 30_000 });
    // settled: nothing changed for 300 ms
    await p.waitForFunction(() => window.__painted > window.__changed && performance.now() - window.__changed > 300, null, { polling: 50 });
  };
  await settle(0);
  if (SECOND && !(await p.$('#next'))) throw new Error(`${name}: no link to a second message (--second)`);
  if (SECOND) {
    // the next message, in the same page: a link sinter follows without a page load
    await p.click('#next');
    await settle(1000);
  }
  const t = await p.evaluate(() => {
    const api = performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/message')).pop();
    return window.__painted - api.responseEnd;
  });
  if (setup.check) await setup.check(p);
  const violations = await p.evaluate(() => window.__violations);
  // Playwright's init script runs in the iframe too, where the sandbox blocks it: the benchmark's, not the page's
  const real = errors.filter((e) => !e.startsWith("Blocked script execution in 'about:srcdoc'"));
  if (violations.length || real.length) throw new Error(`${name}: ${[...violations, ...real].join('\n')}`);
  x.count = await p.evaluate(setup.count ?? (() => document.querySelectorAll('#message *').length));
  await p.close();
  return t;
}

for (const x of vs) await run(x); // a warm-up run of each, discarded
for (let i = 0; i < RUNS; i++) {
  for (let j = 0; j < vs.length; j++) {
    const x = vs[(i + j) % vs.length];
    x.times.push(await run(x));
  }
}
await browser.close();

const results = [];
for (const { name, v, setup, app, server, times, count } of vs) {
  server.close();
  app.remove();
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const apiBytes = Buffer.byteLength(typeof setup.api === 'function' ? setup.api(1) : setup.api);
  results.push({ name, label: v.label, median, times, js: app.js, count, csp: setup.csp ?? CSP, apiBytes });
  console.log(`${name.padEnd(22)} ${median.toFixed(0).padStart(5)} ms   JS ${(app.js.gzip / 1024).toFixed(1).padStart(5)} kB gzip   runs ${times.map((t) => t.toFixed(0)).join(' ')}   (${count} elements; API ${(apiBytes / 1024).toFixed(0)} kB)`);
  if (app.js.files.length > 1) for (const f of app.js.files) console.log(`${''.padEnd(22)}   ${f.file}: ${(f.gzip / 1024).toFixed(1)} kB gzip`);
}
if (process.env.BENCH_JSON) (await import('node:fs')).writeFileSync(process.env.BENCH_JSON, JSON.stringify({ blocks: BLOCKS, htmlBytes: HTML.length, results }, null, 2));
