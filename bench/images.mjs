// When the images of an email arrive: a newsletter (a small logo, a hero with a width only and a mobile copy of it
// that @media shows only on phones, twelve article images, icons, a tracking pixel) through a proxy that waits as an upstream fetch would, under Chromium's
// network throttling. Two ways to render it:
//   eager          <mail-body>'s own <img>: every image requested as soon as it renders
//   lazy           an `image` fill with loading="lazy" on every image (the docs' example)
// Times from navigation start, medians: when the hero's last byte arrives, the largest contentful paint, when
// the first screen's images and all images have arrived, the layout shift (CLS), the image bytes loaded.
//
//   node --experimental-strip-types bench/images.mjs [runs] [upstream ms]
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';
import sinter from '@tiaforge-ui/sinter/vite';
import { app, page } from '../test/app.ts';
import { parse } from '../sinter/parse.ts';

const runs = +(process.argv[2] ?? 7), UPSTREAM = +(process.argv[3] ?? 250);
const ARTICLES = 12, VIEWPORT = { width: 1280, height: 800 };

// ── The images: noise over a gradient, JPEG, so they weigh what photos do ────────────────────────────────
const browser = await chromium.launch();
const draw = async (w, h, type, quality) => {
  const p = await browser.newPage();
  const b64 = await p.evaluate(([w, h, type, quality]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#36c'); grad.addColorStop(1, '#fc6'); g.fillStyle = grad; g.fillRect(0, 0, w, h);
    const d = g.getImageData(0, 0, w, h);
    for (let i = 0; i < d.data.length; i += 4) { const n = (Math.random() - 0.5) * 60; d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n; }
    g.putImageData(d, 0, 0);
    return c.toDataURL(type, quality).split(',')[1];
  }, [w, h, type, quality]);
  await p.close();
  return Buffer.from(b64, 'base64');
};
const IMAGES = {
  'logo.png': [await draw(120, 40, 'image/png'), 'image/png'],
  'hero.jpg': [await draw(1200, 600, 'image/jpeg', 0.7), 'image/jpeg'],
  'hero-mobile.jpg': [await draw(640, 640, 'image/jpeg', 0.7), 'image/jpeg'],
  'icon.png': [await draw(24, 24, 'image/png'), 'image/png'],
  'pixel.png': [await draw(1, 1, 'image/png'), 'image/png'],
};
for (let i = 0; i < ARTICLES; i++) IMAGES[`a${i}.jpg`] = [await draw(500, 300, 'image/jpeg', 0.7), 'image/jpeg'];

// ── The email, as an email builder writes one ─────────────────────────────────────────────────────────────
const SENDER = 'https://news.example/';
const para = '<p style="font:16px/1.5 Arial,sans-serif;margin:0 0 12px">Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p>';
const html = `<style>.m { display: none; max-height: 0; overflow: hidden } @media (max-width: 480px) { .m { display: block !important; max-height: none !important } .d { display: none !important } }</style>
<table width="600" align="center" cellpadding="0" cellspacing="0"><tr><td>
<img src="${SENDER}logo.png" width="120" height="40" alt="logo">
<div class="d"><img src="${SENDER}hero.jpg" width="600" alt="hero" style="display:block;width:100%;max-width:600px;height:auto"></div>
<div class="m"><img src="${SENDER}hero-mobile.jpg" width="320" alt="mobile hero" style="display:block;width:100%;height:auto"></div>
<h1 style="font:28px Arial,sans-serif">This week</h1>${para}${para}
${Array.from({ length: ARTICLES }, (_, i) => `<table width="100%"><tr><td width="250"><img src="${SENDER}a${i}.jpg" width="250" alt="a${i}" style="display:block;width:250px;height:auto"></td><td>${para}</td></tr></table>`).join('\n')}
<p>${[0, 1, 2, 3].map((i) => `<img src="${SENDER}icon.png" width="24" height="24" alt="icon${i}">`).join(' ')}</p>
<img src="${SENDER}pixel.png" width="1" height="1" alt="pixel">
</td></tr></table>`;
const message = JSON.stringify(parse(html, { images: 'proxy', proxy: '/img?url={url}' }));

// ── The server: the pages, the message, the images after the upstream wait ────────────────────────────────
let dist = '';
const s = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/message') { res.setHeader('Content-Type', 'application/json'); return res.end(message); }
  if (u.pathname === '/img') {
    const img = IMAGES[new URL(u.searchParams.get('url')).pathname.slice(1)];
    if (!img) { res.statusCode = 404; return res.end(); }
    return setTimeout(() => { res.setHeader('Content-Type', img[1]); res.end(img[0]); }, UPSTREAM);
  }
  // a page at /lazy/ is dist/lazy/index.html with clean URLs, else dist/lazy.html
  const files = u.pathname.endsWith('/') ? [u.pathname + 'index.html', u.pathname.slice(0, -1) + '.html'] : [u.pathname];
  for (const p of files) {
    try { const b = readFileSync(join(dist, p)); res.setHeader('Content-Type', p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html'); return res.end(b); } catch {}
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => s.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${s.address().port}`;

const RES = '<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n';
const body = (fill = '') => `${RES}<main><mail-body id="message" data-sn-with="{ body: message }">${fill}</mail-body></main>`;
const STYLE = `data-sn-style="{ display: $slot.node.style.display, width: $slot.node.style.width, height: $slot.node.style.height, 'max-width': $slot.node.style['max-width'] }"`;
const fill = (img) => `<template slot="image" data-sn-if="$slot.node.attrs.src">${img}</template><template data-sn-else><span></span></template>`;
const ATTRS = 'alt: $slot.node.attrs.alt, width: $slot.node.attrs.width, height: $slot.node.attrs.height, srcset: null';
const a = app({
  'index.html': page(body()),
  'lazy.html': page(body(fill(`<img loading="lazy" data-sn-attr="{ src: $slot.node.attrs.src, ${ATTRS} }" ${STYLE}>`))),
});
await build({ root: a.root, logLevel: 'silent', plugins: [sinter({ libraries: ['@tiavision/sinter-mail'] })], build: { outDir: join(a.root, 'dist'), emptyOutDir: true, rollupOptions: { input: { index: join(a.root, 'index.html'), lazy: join(a.root, 'lazy.html') } } } });
dist = join(a.root, 'dist');

// which images are on the first screen: the eager page's layout once every image has arrived
const probe = await browser.newPage({ viewport: VIEWPORT });
await probe.goto(origin + '/');
await probe.waitForFunction(() => { const i = [...document.querySelectorAll('#message img')]; return i.length > 10 && i.every((x) => x.complete); }, null, { timeout: 60000 });
const FIRST = await probe.evaluate(() => [...document.querySelectorAll('#message img')].filter((i) => i.getBoundingClientRect().top < innerHeight).map((i) => i.alt));
await probe.close();

const INIT = () => {
  window.__lcp = 0; window.__cls = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
};
const VARIANTS = { eager: '/', lazy: '/lazy/' };
const PROFILES = { 'fast 4G (9 Mbps, 85 ms RTT)': [9e6, 85], 'slow 4G (1.6 Mbps, 150 ms RTT)': [1.6e6, 150] };

const kb = (n) => (n / 1024).toFixed(0);
console.log(`hero ${kb(IMAGES['hero.jpg'][0].length)} kB (mobile copy ${kb(IMAGES['hero-mobile.jpg'][0].length)} kB), articles ${kb(IMAGES['a0.jpg'][0].length)} kB each, upstream ${UPSTREAM} ms; first screen (${VIEWPORT.width}×${VIEWPORT.height}): ${FIRST.join(', ')}; ${runs} runs, medians`);
try {
  for (const [pname, prof] of Object.entries(PROFILES)) {
    console.log(`\n${pname}`);
    for (const [vname, path] of Object.entries(VARIANTS)) {
      const xs = [];
      for (let r = 0; r < runs; r++) {
        const ctx = await browser.newContext({ viewport: VIEWPORT });
        const p = await ctx.newPage();
        await p.addInitScript(INIT);
        const cdp = await ctx.newCDPSession(p);
        await cdp.send('Network.enable');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        await cdp.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: prof[0] / 8, uploadThroughput: prof[0] / 8, latency: prof[1] });
        await p.goto(origin + path);
        await p.waitForFunction(() => { const h = document.querySelector('img[alt="hero"]'); return h?.complete && h.naturalWidth > 0; }, null, { polling: 20, timeout: 120000 });
        await p.waitForTimeout(prof[1] * 4 + 3000);
        xs.push(await p.evaluate((first) => {
          const imgs = performance.getEntriesByType('resource').filter((e) => e.name.includes('/img?'));
          const at = (alt) => document.querySelector(`#message img[alt="${alt}"]`)?.src;
          const end = (srcs) => Math.max(...imgs.filter((e) => srcs.includes(e.name)).map((e) => e.responseEnd));
          return {
            hero: end([at('hero')]), screen: end(first.map(at)), all: Math.max(...imgs.map((e) => e.responseEnd)),
            lcp: window.__lcp, cls: window.__cls, bytes: imgs.reduce((t, e) => t + e.encodedBodySize, 0),
          };
        }, FIRST));
        await ctx.close();
      }
      const med = (k) => { const v = xs.map((x) => x[k]).sort((p, q) => p - q); return v[v.length >> 1]; };
      const ms = (k) => med(k).toFixed(0).padStart(5);
      console.log(`  ${vname.padEnd(13)} hero ${ms('hero')} ms   LCP ${ms('lcp')} ms   first screen ${ms('screen')} ms   all ${ms('all')} ms   CLS ${med('cls').toFixed(3)}   images ${kb(med('bytes')).padStart(4)} kB`);
    }
  }
} finally {
  await browser.close(); s.close(); a.remove();
}
