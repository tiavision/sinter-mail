// The components in Chromium, over built apps served with an API (proposal, sections 4, 6, 7 and 9).
//
// - A tree from the API, rendered in the browser under `script-src 'self'; style-src 'self';
//   require-trusted-types-for 'script'`: its styles apply (sinter sets them with style.setProperty, which
//   the policy allows), and nothing is reported (no violation, no console error).
// - The same email folded at build time (a `file:` tree on a static page): its styles are inline `style=""`
//   attributes, which `style-src 'self'` blocks, and `style-src-attr 'unsafe-inline'` lets apply. The docs
//   must say so: an email from a file needs `style-src-attr 'unsafe-inline'`.
// - Measured, and printed: the time to render a generated newsletter of 2,000 elements from the API, and the
//   page's JavaScript gzipped, with the components and without them.
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import sinter from '@tiaforge-ui/sinter/vite';
import type { Body } from '../sinter/sinter.types.js';
import { app, elements, newsletter, page, PKG } from './app.js';

const CSP = "script-src 'self'; style-src 'self'; require-trusted-types-for 'script'";
const HEAD = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
const ALL = readFileSync(join(PKG, 'fixtures/trees/all.json'), 'utf8');
const STATIC = readFileSync(join(PKG, 'fixtures/trees/static.json'), 'utf8');
const BIG = newsletter(2000);
/** a reset as apps write them, on a dark page */
const RESET = `:root { color-scheme: dark; background: #111; color: #eee; }
*, *::before, *::after { box-sizing: border-box; margin: 0; }
img { display: block; max-width: 100%; }
table { width: 100%; border-collapse: collapse; }
td, th { padding: 1rem; border: 1px solid #444; }`;
const BIG_COUNT = [...BIG.children.flatMap((c) => [...elements(c)])].length;

// the API page, the same page without the components (for the bundle's size), the static page
const apps = {
  api: app({ 'index.html': page('<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n<main><mail-body id="message" data-sn-with="{ body: message }"></mail-body></main>', HEAD) }),
  // the same, always through the templates (`templates`): a numbered body renders in steps there
  steps: app({ 'index.html': page('<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n<main><mail-body id="message" data-sn-with="{ body: message, templates: true }"></mail-body></main>', HEAD) }),
  plain: app({ 'index.html': page('<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n<main><p id="message" data-sn-text="message.type"></p></main>', HEAD) }),
  static: app({ 'tree.json': STATIC, 'index.html': page('<sn-resource name="mail" src="file:./tree.json" type="Body"></sn-resource>\n<main><mail-body id="message" data-sn-with="{ body: mail }"></mail-body></main>') }),
  // an email's HTML parsed in the page for the width <mail-width> reports
  width: app({ 'index.html': page(`<sn-resource name="html" src="/api/html" type="string"></sn-resource>
<main data-sn-state="{ media: /** @type {'wide' | 'narrow' | null} */ (null) }"><mail-width data-sn-on-media="media = $event.detail"></mail-width><mail-body id="message" data-sn-with="{ body: html && media ? mail.parse(html, { images: 'allow', media }) : null }"></mail-body></main>`, HEAD) }),
  // an app with a reset on a dark page, without mail.css and with it (imported through the package's export)
  reset: app({ 'index.html': page('<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n<main><mail-body id="message" data-sn-with="{ body: message }"></mail-body></main>', `${HEAD}<link rel="stylesheet" href="/src/app.css">`), 'src/app.css': RESET }),
  mailcss: app({ 'index.html': page('<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n<main><mail-body id="message" data-sn-with="{ body: message }"></mail-body></main>', `${HEAD}<link rel="stylesheet" href="/src/app.css">`), 'src/app.css': `@import '@tiavision/sinter-mail/mail.css';\n${RESET}` }),
  // the same email parsed for a phone from the start, without <mail-width>: what waiting for it is compared with
  narrow: app({ 'index.html': page(`<sn-resource name="html" src="/api/html" type="string"></sn-resource>
<main><mail-body id="message" data-sn-with="{ body: html ? mail.parse(html, { images: 'allow', media: 'narrow' }) : null }"></mail-body></main>`, HEAD) }),
};
const servers: Server[] = [];
let browser: Browser;
/** what /api/message answers */
let message = ALL;
/** what /api/html answers (a JSON string), and the images requested from /img/ */
let mailHtml = '""';
const images: string[] = [];

/** a build and its API; `csp`: the policy header of each page, by its query (`?attr`) */
function serve(dir: string, csp?: (q: URLSearchParams) => string): Promise<string> {
  const s = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/message') { res.setHeader('Content-Type', 'application/json'); return res.end(message); }
    if (url.pathname === '/api/html') { res.setHeader('Content-Type', 'application/json'); return res.end(mailHtml); }
    if (url.pathname.startsWith('/img/')) { images.push(url.pathname.slice(5)); res.statusCode = 404; return res.end(); }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    try {
      const body = readFileSync(join(dir, path));
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      if (csp && path.endsWith('.html')) res.setHeader('Content-Security-Policy', csp(url.searchParams));
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}/`)));
}

/** a tab that records every policy violation and console error */
async function tab(): Promise<{ page: Page; violations: () => Promise<string[]>; errors: string[] }> {
  const p = await browser.newPage();
  const errors: string[] = [];
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => {
    const w = window as unknown as { __violations: string[]; __last: number };
    w.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => w.__violations.push(`${e.violatedDirective} ${e.sample}`));
    // the time of the last change to the page, for the render time
    w.__last = 0;
    new MutationObserver(() => { w.__last = performance.now(); }).observe(document, { subtree: true, childList: true, attributes: true });
  });
  return { page: p, errors, violations: () => p.evaluate(() => (window as unknown as { __violations: string[] }).__violations) };
}

const dist = (a: keyof typeof apps) => join(apps[a].root, 'dist');
beforeAll(async () => {
  for (const name of ['api', 'steps', 'plain', 'width', 'narrow', 'reset', 'mailcss'] as const) {
    // (`as never`: sinter from a local path brings its own copy of Vite's types, which TypeScript sees as another Vite)
    await build({ root: apps[name].root, logLevel: 'silent', plugins: [sinter({ libraries: ['@tiavision/sinter-mail'] }) as never], build: { outDir: dist(name), emptyOutDir: true } });
  }
  await build({ root: apps.static.root, logLevel: 'silent', plugins: [sinter({ libraries: ['@tiavision/sinter-mail'], static: ['index.html'] }) as never], build: { outDir: dist('static'), emptyOutDir: true } });
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  for (const s of servers) s.close();
  for (const a of Object.values(apps)) a.remove();
});

/** the computed styles the test reads, of the first element a selector finds */
const computed = (p: Page, sel: string, props: string[]) => p.$eval(sel, (e, ps) => Object.fromEntries(ps.map((x) => [x, getComputedStyle(e).getPropertyValue(x)])), props);

/** what the fixture's styles make of its elements, as the browser computes them */
async function styled(p: Page) {
  return {
    root: await computed(p, '#message', ['display', 'background-color', 'font-family', 'color']),
    table: await computed(p, '#message #mail-top', ['width', 'background-color', 'border-collapse', 'table-layout']),
    cell: await computed(p, '#message #mail-top td', ['padding-left', 'background-color', 'color', 'vertical-align']),
    quote: await computed(p, '#message .mail-quote', ['border-left-width', 'border-left-style', 'padding-left']),
    signature: await computed(p, '#message .mail-signature', ['font-size', 'color']),
    th: await computed(p, '#message th', ['text-align', 'padding-top']),
  };
}
const STYLED = {
  root: { display: 'flow-root', 'background-color': 'rgb(238, 238, 238)', 'font-family': 'Arial, sans-serif', color: 'rgb(34, 34, 34)' },
  table: { width: '600px', 'background-color': 'rgb(255, 255, 255)', 'border-collapse': 'separate', 'table-layout': 'fixed' },
  cell: { 'padding-left': '12px', 'background-color': 'rgb(0, 51, 102)', color: 'rgb(255, 255, 255)', 'vertical-align': 'top' },
  quote: { 'border-left-width': '3px', 'border-left-style': 'solid', 'padding-left': '12px' },
  signature: { 'font-size': '12px', color: 'rgb(102, 102, 102)' },
  th: { 'text-align': 'left', 'padding-top': '8px' },
};

test('a tree from the API renders under Trusted Types and style-src \'self\', its styles applied, nothing reported', async () => {
  message = ALL;
  const { page: p, violations, errors } = await tab();
  await p.goto(await serve(dist('api')));
  await p.waitForFunction(() => !!document.querySelector('#message .mail-signature'));
  expect(await styled(p)).toEqual(STYLED);
  // links open in a new tab; ids are prefixed; a blocked image keeps its box and has no src
  expect(await p.$eval('#message a[href="https://example.com/news"]', (a) => [a.getAttribute('target'), a.getAttribute('rel')])).toEqual(['_blank', 'noopener noreferrer']);
  expect(await p.$$eval('#message [id]', (es) => es.map((e) => e.id))).toEqual(['mail-top', 'mail-bottom']);
  expect(await p.$eval('#message img[alt="Acme Weekly"]', (i) => [i.getAttribute('src'), i.getAttribute('srcset'), (i as HTMLImageElement).width, (i as HTMLImageElement).height])).toEqual([null, null, 200, 50]);
  // every tag of the fixture is in the page
  const tags = new Set([...(JSON.parse(ALL) as Body).children.flatMap((c) => [...elements(c)])].map((e) => e.tag));
  expect(await p.$$eval('#message *', (es) => [...new Set(es.map((e) => e.localName))].sort())).toEqual([...tags].sort());
  expect(await violations()).toEqual([]);
  expect(errors).toEqual([]);
});

test('an email folded at build time: style-src \'self\' blocks its inline styles, style-src-attr \'unsafe-inline\' lets them apply', async () => {
  expect(existsSync(join(dist('static'), 'assets'))).toBe(false);
  expect(readFileSync(join(dist('static'), 'index.html'), 'utf8').replace(/<script type="speculationrules">[^<]*<\/script>/, '')).not.toMatch(/<script/);
  const base = await serve(dist('static'), (q) => (q.has('attr') ? "style-src 'self'; style-src-attr 'unsafe-inline'" : "style-src 'self'"));

  const blocked = await tab();
  await blocked.page.goto(base);
  await blocked.page.waitForFunction(() => !!document.querySelector('#message .mail-signature'));
  const v = await blocked.violations();
  expect(v.length).toBeGreaterThan(0);
  expect(new Set(v.map((x) => x.split(' ')[0]))).toEqual(new Set(['style-src-attr']));
  // nothing of the email's look applies: browser defaults
  expect((await computed(blocked.page, '#message', ['display'])).display).toBe('block');
  expect((await computed(blocked.page, '#message #mail-top', ['width'])).width).not.toBe('600px');
  expect((await computed(blocked.page, '#message .mail-signature', ['font-size']))['font-size']).toBe('16px');

  const allowed = await tab();
  await allowed.page.goto(`${base}?attr`);
  await allowed.page.waitForFunction(() => !!document.querySelector('#message .mail-signature'));
  expect(await styled(allowed.page)).toEqual(STYLED);
  expect(await allowed.violations()).toEqual([]);
  expect([...blocked.errors.filter((e) => !/Content Security Policy/.test(e)), ...allowed.errors]).toEqual([]);
});

test(`measured: a newsletter of ${BIG_COUNT} elements from the API, and the page's JavaScript with and without the components`, async () => {
  message = JSON.stringify(BIG);
  const base = await serve(dist('api'));
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const { page: p, violations, errors } = await tab();
    await p.goto(base);
    await p.waitForFunction((n) => document.querySelectorAll('#message *').length === n, BIG_COUNT, { polling: 50 });
    // settle, then the time from the API's answer to the last change of the page
    await p.waitForTimeout(200);
    const t = await p.evaluate(() => {
      const api = performance.getEntriesByType('resource').find((e) => e.name.endsWith('/api/message')) as PerformanceResourceTiming;
      return (window as unknown as { __last: number }).__last - api.responseEnd;
    });
    times.push(t);
    // the styles are there
    expect((await computed(p, '#message td td', ['padding-left', 'border-bottom-style']))).toEqual({ 'padding-left': '8px', 'border-bottom-style': 'solid' });
    expect(await violations()).toEqual([]);
    expect(errors).toEqual([]);
    await p.close();
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)]!;
  // the page's JavaScript: every .js file of the build (the page module and what it imports)
  const size = (a: 'api' | 'plain') => {
    const files = readdirSync(join(dist(a), 'assets')).filter((f) => f.endsWith('.js'));
    const all = files.map((f) => readFileSync(join(dist(a), 'assets', f)));
    return { raw: all.reduce((n, b) => n + b.length, 0), gzip: all.reduce((n, b) => n + gzipSync(b, { level: 9 }).length, 0) };
  };
  const withC = size('api'), without = size('plain');
  console.log([
    `render of ${BIG_COUNT} elements from the API (Chromium, API answer to last change): median ${median.toFixed(0)} ms (runs: ${times.map((t) => t.toFixed(0)).join(', ')} ms)`,
    `page JavaScript with the components: ${(withC.raw / 1024).toFixed(1)} kB, ${(withC.gzip / 1024).toFixed(1)} kB gzip`,
    `page JavaScript without them:        ${(without.raw / 1024).toFixed(1)} kB, ${(without.gzip / 1024).toFixed(1)} kB gzip`,
    `the components add ${((withC.gzip - without.gzip) / 1024).toFixed(1)} kB gzip`,
  ].join('\n'));
  expect(median).toBeLessThan(5000);
}, 180_000);

test('a long tree that mail.progressive numbered: through the templates its first part paints first, then the rest in steps; the fast path renders it whole; the page is what a whole render gives', async () => {
  const { progressive } = await import('../sinter/tree.js');
  const big = newsletter(2000);
  /** the email's elements, without the hidden one a progressive render ends with (its steps' component) */
  const SEL = '#message *:not(#message > i[hidden])';
  const html = async (tree: Body, at: 'api' | 'steps' = 'steps') => {
    message = JSON.stringify(tree);
    const { page: p, violations, errors } = await tab();
    // the first frame with the email in it: how many of its elements it holds
    await p.addInitScript((sel) => {
      const w = window as unknown as { __first: number };
      const look = () => { const n = document.querySelectorAll(sel).length; if (n) w.__first = n; else requestAnimationFrame(look); };
      requestAnimationFrame(look);
    }, SEL);
    await p.goto(await serve(dist(at)));
    await p.waitForFunction(([sel, n]) => document.querySelectorAll(sel as string).length === n, [SEL, BIG_COUNT] as const, { polling: 50 });
    const out = await p.$eval('#message', (m) => m.innerHTML.replace(/<!--[^>]*-->/g, '').replace('<i hidden=""></i>', ''));
    const first = await p.evaluate(() => (window as unknown as { __first: number }).__first);
    expect(await violations()).toEqual([]);
    expect(errors).toEqual([]);
    await p.close();
    return { first, out };
  };
  const whole = await html(big), parts = await html(progressive(big, 200));
  expect(whole.first).toBe(BIG_COUNT);
  expect(parts.first).toBeLessThan(200);
  expect(parts.out).toBe(whole.out);
  // the fast path (no fill, a body from an API): a numbered body whole in its first frame, the same page
  const fast = await html(progressive(big, 200), 'api');
  expect(fast.first).toBe(BIG_COUNT);
  expect(fast.out).toBe(whole.out);
}, 120_000);

test('<mail-width>: a reader that narrows gets the email\'s phone layout, parsed again, and only then its mobile image', async () => {
  const url = await serve(dist('width'));
  const img = (name: string) => `${url}img/${name}`;
  mailHtml = JSON.stringify(`<style>.m { display: none } @media (max-width: 480px) { .m { display: block !important } .d { display: none !important } }</style>
<div class="d"><img src="${img('desktop.jpg')}" alt="desktop" width="600"><p>Desktop layout</p></div>
<div class="m"><img src="${img('mobile.jpg')}" alt="mobile" width="320"><p>Mobile layout</p></div>`);
  images.length = 0;
  const { page: p, violations, errors } = await tab();
  await p.setViewportSize({ width: 1000, height: 700 });
  await p.goto(url);
  await p.waitForFunction(() => document.querySelector('#message')?.textContent?.includes('layout'));
  expect((await p.textContent('#message'))?.trim()).toBe('Desktop layout');
  await p.waitForTimeout(200);
  expect(images).toEqual(['desktop.jpg']);
  // narrower than the breakpoint: the event, a new parse for 375 px, the mobile block rendered and its image requested
  await p.setViewportSize({ width: 400, height: 700 });
  await p.waitForFunction(() => document.querySelector('#message')?.textContent?.trim() === 'Mobile layout');
  await p.waitForTimeout(200);
  expect(images).toEqual(['desktop.jpg', 'mobile.jpg']);
  expect(await p.$$eval('#message img', (is) => is.map((i) => i.getAttribute('alt')))).toEqual(['mobile']);
  // and back
  await p.setViewportSize({ width: 1000, height: 700 });
  await p.waitForFunction(() => document.querySelector('#message')?.textContent?.trim() === 'Desktop layout');
  // it measures and shows nothing
  expect(await p.$eval('.mail-width', (e) => [e.getAttribute('aria-hidden'), e.getBoundingClientRect().height])).toEqual(['true', 0]);
  expect(await violations()).toEqual([]);
  expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
});

/** the page opened at a phone's width: every text the email's box held, the images requested, and how long after its
 * HTML arrived the email was in the page */
async function phone(name: keyof typeof apps) {
  const url = await serve(dist(name));
  const img = (n: string) => `${url}img/${n}`;
  mailHtml = JSON.stringify(`<style>.m { display: none } @media (max-width: 480px) { .m { display: block !important } .d { display: none !important } }</style>
<div class="d"><img src="${img('desktop.jpg')}" alt="desktop" width="600"><p>Desktop layout</p></div>
<div class="m"><img src="${img('mobile.jpg')}" alt="mobile" width="320"><p>Mobile layout</p></div>`);
  images.length = 0;
  const { page: p, errors } = await tab();
  await p.addInitScript(() => {
    const w = window as unknown as { __seen: Set<string>; __shown: number };
    w.__seen = new Set(); w.__shown = 0;
    new MutationObserver(() => {
      const t = document.querySelector('#message')?.textContent?.trim();
      if (t) { w.__seen.add(t); w.__shown ||= performance.now(); }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await p.setViewportSize({ width: 400, height: 700 });
  await p.goto(url);
  await p.waitForFunction(() => document.querySelector('#message')?.textContent?.trim() === 'Mobile layout');
  await p.waitForTimeout(200);
  const seen = await p.evaluate(() => [...(window as unknown as { __seen: Set<string> }).__seen]);
  const gap = await p.evaluate(() => (window as unknown as { __shown: number }).__shown - (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).find((e) => e.name.endsWith('/api/html'))!.responseEnd);
  await p.close();
  return { seen, images: [...images], gap, errors: errors.filter((e) => !e.includes('404')) };
}

test('<mail-width>: opened on a phone, the email is parsed once, for the phone: its desktop layout and image never come', async () => {
  const runs: Array<Record<'width' | 'narrow', Awaited<ReturnType<typeof phone>>>> = [];
  for (let i = 0; i < 5; i++) runs.push({ width: await phone('width'), narrow: await phone('narrow') });
  for (const r of runs) {
    expect(r.width.seen).toEqual(['Mobile layout']);
    expect(r.width.images).toEqual(['mobile.jpg']);
    expect(r.width.errors).toEqual([]);
  }
  // waiting for <mail-width> costs no frame: the email is in the page as soon after its HTML as with a fixed width
  const med = (k: 'width' | 'narrow') => runs.map((r) => r[k].gap).sort((a, b) => a - b)[2]!;
  console.log(`<mail-width>: the email in the page ${med('width').toFixed(1)} ms after its HTML arrived (${med('narrow').toFixed(1)} ms parsed for a phone from the start)`);
  expect(med('width') - med('narrow')).toBeLessThan(16);
});

test('mail.css gives an email back what an app\'s reset takes, and a light canvas on a dark page to one written for white', async () => {
  const { parse } = await import('../sinter/parse.js');
  const tree = parse('<table><tr><td><p style="color:#333">Hello <img src="data:image/png;base64,iVBORw0KGgo=" alt="" width="20" height="20"> there</p><p>Second</p></td></tr></table>');
  expect(tree.light).toBe(true);
  message = JSON.stringify(tree);
  const look = async (name: keyof typeof apps) => {
    const { page: p, violations } = await tab();
    await p.setViewportSize({ width: 1000, height: 700 });
    await p.goto(await serve(dist(name)));
    await p.waitForFunction(() => document.querySelector('#message p'));
    const out = {
      root: await computed(p, '#message', ['color-scheme', 'background-color', 'color']),
      cls: await p.$eval('#message', (e) => e.className),
      table: await p.$eval('#message table', (t) => [t.getBoundingClientRect().width < 900, getComputedStyle(t).borderCollapse]),
      td: await computed(p, '#message td', ['padding-top', 'border-top-style']),
      p: await computed(p, '#message p', ['margin-top', 'box-sizing']),
      img: await computed(p, '#message img', ['display']),
      violations: await violations(),
    };
    await p.close();
    return out;
  };
  const without = await look('reset'), withCss = await look('mailcss');
  // <mail-body> marks it either way; without mail.css the reset reaches the email
  expect(without.cls).toBe('mail mail-light');
  expect(without).toMatchObject({ table: [false, 'collapse'], td: { 'padding-top': '16px', 'border-top-style': 'solid' }, p: { 'margin-top': '0px', 'box-sizing': 'border-box' }, img: { display: 'block' } });
  // with it: the browser's tables and inline images, the spacing, content-box, and the light canvas
  expect(withCss).toMatchObject({
    cls: 'mail mail-light',
    root: { 'color-scheme': 'light', 'background-color': 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' },
    table: [true, 'separate'], td: { 'border-top-style': 'none' },
    p: { 'margin-top': '16px', 'box-sizing': 'content-box' }, img: { display: 'inline' }, violations: [],
  });
  // the cell's padding is the browser's own again, not the reset's
  expect(withCss.td['padding-top']).not.toBe('16px');
});
