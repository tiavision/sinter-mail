// An email's HTML from an API (or decrypted in the page: a PGP mail's tree cannot come from the server), from its
// arrival to the email painted, in Chromium: sinter-mail against what Caley did before it moved to sinter-mail
// (bench/caley/: DOMPurify with its hook and cleanStyle, then a sandboxed srcdoc iframe).
//
//   mail       the action answers the HTML; mail.parse in a let, <mail-body> (the script builder)
//   base       the same page built with another checkout of this package (BASE=<dir>), to compare a change
//   warm       `mail` with <mail-warm> on the page: the parser has run on sample emails while the page was idle
//   hints      `mail` with sinter({ compileHints: true }); warm+hints: both
//   frame      the action sanitizes (prepareEmailHtml); <mail-frame>, sandbox with allow-same-origin
//   isolated   the same, sandbox without allow-same-origin: Caley's frame for decrypted mail. In Chrome such a
//              frame is its own process (the iframe's document is parsed, laid out and painted there)
//
// Each page is a reader: a button opens the next message, an action fetches it (/api/message), as Caley's reader
// does (<sn-resource call="mail.body(open)">). Per email of bench/corpus, per variant:
//   first      the first message opened in a page loaded and idle: the code has not run yet
//   next       a message opened after ten others (the corpus twice): the code is warm, as in a session
// Measured from a trace, from the message's last byte (ResourceFinish) to the end of the main-thread frame that
// paints the whole email (the first Paint after the email's elements are all in a document): `wall`, and `cpu`,
// the main threads' busy time in between (every renderer process: an isolated frame's too), split into script,
// HTML parsing, style, layout and paint. Medians.
//
//   node --experimental-strip-types bench/html.mjs [runs=7] [emails=all] [variants=mail,warm,frame,isolated]
//   BASE=../sinter-mail-base node --experimental-strip-types bench/html.mjs 9 newsletter mail,base
//   OPENS=6 node --experimental-strip-types bench/html.mjs 5 newsletter mail,warm     the same email six times in a row
// IDLE=<ms>: how long the loaded page waits before its first message (1000). JSON_OUT=<file>: the medians as JSON.
//
// Chrome's new headless mode (channel: 'chromium'), not the headless shell, which keeps a sandboxed frame in the
// page's process. Needs sinter built beside this package (../sinter, npm run build).
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { chromium } from 'playwright';

const PKG = resolve(import.meta.dirname, '..');
const [runsArg = '7', emailsArg = 'all', variantsArg = 'mail,warm,frame,isolated'] = process.argv.slice(2);
const RUNS = +runsArg, OPENS = +(process.env.OPENS ?? 0), IDLE_MS = +(process.env.IDLE ?? 1000);
const CORPUS = ['reply', 'receipt', 'outlook', 'newsletter', 'digest'];
const EMAILS = emailsArg === 'all' ? CORPUS : emailsArg.split(',');
const VARIANTS = variantsArg.split(',');
const HTML = Object.fromEntries(CORPUS.map((n) => [n, readFileSync(join(PKG, 'bench/corpus', n + '.html'), 'utf8')]));

// ── The apps ──────────────────────────────────────────────────────────────────────────────────────────
const page = (body, head = '') => `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>reader</title><style>body { margin: 0; font: 14px/1.4 system-ui, sans-serif } .reader { display: flex; flex-direction: column; height: calc(100vh - 40px); overflow: auto }</style>${head}</head>\n<body>\n${body}\n</body>\n</html>\n`;
const READER = (inner) => `<main data-sn-state="{ n: 0 }">
  <button id="next" data-sn-on-click="n++">next</button>
  <sn-resource name="msg" call="bench.body(n)" when="n" type="{ n: number; html: string }"></sn-resource>
  ${inner}
</main>`;
const ACTIONS = "export * as bench from './bench.ts';\n";
const FETCH = "const r = await fetch('/api/message?n=' + n, { signal: ctx.signal });\n  const html = ((await r.json()) as { html: string }).html;";
const FILES = {
  mail: (warm) => ({
    'index.html': page(READER(`${warm ? '<mail-warm></mail-warm>' : ''}<div class="reader" data-sn-let="{ body: msg ? mail.parse(msg.html, { images: 'proxy', proxy: '/api/email/proxy-image?url={url}', cid: '/api/email/proxy-image?uid=1&cid={cid}' }) : null }"><mail-body id="message" data-sn-with="{ body }"></mail-body></div>`)),
    'src/sinter.helpers.ts': "export * as mail from '@tiavision/sinter-mail';\n",
    'src/sinter.types.ts': "export type { Body, Element } from '@tiavision/sinter-mail';\n",
    'src/sinter.actions.ts': ACTIONS,
    'src/bench.ts': `export async function body(n: number, ctx: { signal: AbortSignal }) {\n  ${FETCH}\n  return { n, html };\n}\n`,
  }),
  frame: (isolated) => ({
    'index.html': page(READER(`<div class="reader"><template data-sn-if="msg"><mail-frame id="message" data-sn-with="{ html: msg.html, isolated: ${isolated}, label: 'Mail' }"></mail-frame></template></div>`),
      '<style>.mail-frame { display: flex; flex-direction: column; flex: 1; min-block-size: 0 } .mail-frame iframe { display: block; inline-size: 100%; border: 0; flex: 1; min-block-size: 0 }</style>'),
    'src/sinter.actions.ts': ACTIONS,
    'src/bench.ts': `import { prepareEmailHtml } from './mail-html.ts';\nexport async function body(n: number, ctx: { signal: AbortSignal }) {\n  ${FETCH}\n  return { n, html: prepareEmailHtml(html, { accountId: 'a', mailbox: 'INBOX', uid: 1 }) };\n}\n`,
    'src/mail-html.ts': readFileSync(join(PKG, 'bench/caley/mail-html.ts'), 'utf8'),
    'src/components/mail-frame.html': readFileSync(join(PKG, 'bench/caley/mail-frame.html'), 'utf8'),
    'src/components/mail-frame.ts': readFileSync(join(PKG, 'bench/caley/mail-frame.ts'), 'utf8'),
  }),
};

/** an app folder with `files`, this package (or `pkg`), sinter and DOMPurify linked into its node_modules, built */
async function app(files, pkg = PKG, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sinter-mail-bench-'));
  for (const [f, s] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), s); }
  for (const d of ['@tiaforge-ui', '@tiavision']) mkdirSync(join(root, 'node_modules', d), { recursive: true });
  symlinkSync(pkg, join(root, 'node_modules/@tiavision/sinter-mail'), 'dir');
  symlinkSync(realpathSync(join(pkg, 'node_modules/@tiaforge-ui/sinter')), join(root, 'node_modules/@tiaforge-ui/sinter'), 'dir');
  symlinkSync(realpathSync(join(PKG, 'node_modules/dompurify')), join(root, 'node_modules/dompurify'), 'dir');
  const sinter = (await import(join(pkg, 'node_modules/@tiaforge-ui/sinter/dist/vite.js'))).default;
  await build({ root, logLevel: 'silent', plugins: [sinter({ libraries: files['src/sinter.helpers.ts'] ? ['@tiavision/sinter-mail'] : [], ...options })], build: { outDir: join(root, 'dist'), emptyOutDir: true, minify: !process.env.NOMIN } });
  const js = readdirSync(join(root, 'dist/assets')).filter((f) => f.endsWith('.js'));
  return { root, gzip: js.reduce((n, f) => n + gzipSync(readFileSync(join(root, 'dist/assets', f)), { level: 9 }).length, 0), remove: () => rmSync(root, { recursive: true, force: true }) };
}

const APPS = {};
for (const v of VARIANTS) {
  APPS[v] = v === 'frame' || v === 'isolated' ? await app(FILES.frame(v === 'isolated'))
    : await app(FILES.mail(v.includes('warm')), v === 'base' ? resolve(process.env.BASE ?? '') : PKG, v.includes('hints') ? { compileHints: true } : {});
}

/**
 * Message `n` of an email: the same markup with other words (each letter of its text moved `n` places in the
 * alphabet), as the next email of a session is another text. Nothing is then answered from a cache: not the parse
 * (another source), not the frame (which keeps a document it already shows), and not the browser's shaped words,
 * which make the layout of a text it has laid out before several times cheaper than a new text's.
 */
function vary(html, n) {
  const k = n % 25 + 1;
  return html.replace(/(<style[\s\S]*?<\/style>|<!--[\s\S]*?-->|<[^>]*>|&[#\w]+;)|[a-z]/gi, (m, keep) => {
    if (keep) return m;
    const c = m.charCodeAt(0), a = c < 97 ? 65 : 97;
    return String.fromCharCode(a + (c - a + k) % 26);
  });
}

// ── The servers: one per app; the message, the proxied images ────────────────────────────────────────
const IMAGE_MS = 150;
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
let current = 'reply';
const servers = [], ORIGIN = {};
for (const v of VARIANTS) {
  const s = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/api/message') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ html: vary(HTML[current], +u.searchParams.get('n')) }));
    }
    // an image arrives as over a network, after the email is painted, and is not cached: the first message's images
    // and a later one's are equally absent from the first paint (on localhost they would arrive before it, and lay
    // the first message out twice)
    if (u.pathname === '/api/email/proxy-image') return void setTimeout(() => { res.setHeader('Content-Type', 'image/gif'); res.setHeader('Cache-Control', 'no-store'); res.end(GIF); }, IMAGE_MS);
    const path = u.pathname === '/' ? '/index.html' : u.pathname;
    try {
      const b = readFileSync(join(APPS[v].root, 'dist', path));
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(b);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  ORIGIN[v] = `http://127.0.0.1:${s.address().port}/`;
}

// ── Measuring ─────────────────────────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] });
/** the page says when the email's elements are in it (a mark, read from the trace) and when it is shown (polled) */
const INIT = () => {
  window.__shown = 0;
  const done = () => { performance.mark('mail-built'); window.__shown++; };
  // <mail-body>: the builder's fragment arrives in #message; <mail-frame>: the frame's document has loaded
  new MutationObserver((rs) => { if (rs.some((r) => r.target instanceof Element && r.target.closest('#message') && [...r.addedNodes].some((n) => n.nodeType === 1 && n.localName !== 'iframe'))) done(); })
    .observe(document, { subtree: true, childList: true });
  document.addEventListener('load', (e) => { if (e.target instanceof HTMLIFrameElement) { performance.mark('frame-load'); window.__shown++; } }, true);
};
const CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'loading', 'v8'];
const PARTS = { parse: ['ParseHTML'], style: ['UpdateLayoutTree'], layout: ['Layout'], paint: ['PrePaint', 'Paint', 'Layerize', 'Commit'], gc: ['MinorGC', 'MajorGC'] };

/** opens the next message in `p`; with `trace`, what the trace says about it */
async function open(p, name, trace, framed) {
  current = name;
  const before = await p.evaluate(() => window.__shown);
  if (trace) await browser.startTracing(p, { categories: CATEGORIES });
  await p.click('#next');
  await p.waitForFunction((b) => window.__shown > b, before, { polling: 10, timeout: 30000 });
  await p.waitForTimeout(trace ? 120 : 30);
  if (!trace) return null;
  const events = JSON.parse((await browser.stopTracing()).toString()).traceEvents;
  if (process.env.TRACE_OUT) writeFileSync(process.env.TRACE_OUT, JSON.stringify(events));
  return analyze(events, framed);
}

function analyze(ev, framed) {
  const mains = new Set(ev.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`));
  const main = ev.filter((e) => mains.has(`${e.pid}:${e.tid}`));
  const send = ev.find((e) => e.name === 'ResourceSendRequest' && String(e.args?.data?.url).includes('/api/message'));
  const fin = ev.find((e) => e.name === 'ResourceFinish' && e.args?.data?.requestId === send?.args?.data?.requestId);
  if (!fin) throw new Error('no message request in the trace');
  const t0 = fin.ts;
  // when the email's elements are all in a document, and the first paint of that document after it. <mail-body>: the
  // page's mark as the builder's fragment arrives. A frame: the first layout of its whole document (the layout with
  // the most objects; a frame in a process of its own reports neither its parsing nor its DOMContentLoaded here)
  let built, paint;
  if (framed) {
    const page = ev.find((e) => e.name === 'TracingStartedInBrowser')?.args?.data?.frames?.[0]?.frame;
    const layouts = main.filter((e) => e.ph === 'X' && e.name === 'Layout' && e.ts >= t0 && e.args?.beginData?.frame !== page);
    const most = Math.max(...layouts.map((e) => e.args.beginData.totalObjects));
    built = layouts.find((e) => e.args.beginData.totalObjects === most);
    if (!built || most < 20) throw new Error('the frame was never laid out in the trace');
    paint = main.find((e) => e.ph === 'X' && e.name === 'Paint' && e.ts >= built.ts && e.args?.data?.frame === built.args.beginData.frame);
  } else {
    built = main.find((e) => e.ts >= t0 && e.name === 'mail-built');
    if (!built) throw new Error('the email never arrived in the trace');
    paint = main.find((e) => e.pid === built.pid && e.ph === 'X' && e.name === 'Paint' && e.ts >= built.ts);
  }
  if (!paint) throw new Error('no paint after the email arrived');
  const tasks = main.filter((e) => e.ph === 'X' && e.name === 'RunTask' && e.ts + e.dur > t0);
  const frame = tasks.find((t) => t.pid === paint.pid && t.tid === paint.tid && t.ts <= paint.ts && t.ts + t.dur >= paint.ts + paint.dur);
  const end = frame ? frame.ts + frame.dur : paint.ts + paint.dur;
  const clip = (e) => Math.max(0, Math.min(e.ts + e.dur, end) - Math.max(e.ts, t0));
  const out = { wall: (end - t0) / 1000, cpu: tasks.reduce((n, t) => n + clip(t), 0) / 1000, processes: new Set(tasks.filter((t) => clip(t) > 500).map((t) => t.pid)).size };
  let known = 0;
  for (const [k, names] of Object.entries(PARTS)) {
    out[k] = main.filter((e) => e.ph === 'X' && names.includes(e.name)).reduce((n, e) => n + clip(e), 0) / 1000;
    known += out[k];
  }
  out.script = out.cpu - known;
  return out;
}

const med = (xs) => { const v = [...xs].sort((a, b) => a - b); return v[v.length >> 1]; };
const KEYS = ['wall', 'cpu', 'script', 'parse', 'style', 'layout', 'paint', 'gc'];
const row = (rs) => KEYS.map((k) => med(rs.map((r) => r[k])).toFixed(1).padStart(7)).join('');

console.log(`Chromium ${browser.version()}; ${RUNS} runs, medians, ms from the message's last byte to the email painted`);
console.log(`page JavaScript, gzip: ${VARIANTS.map((v) => `${v} ${(APPS[v].gzip / 1024).toFixed(1)} kB`).join(', ')}`);
const results = {};
const fresh = async (v) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.addInitScript(INIT);
  await p.goto(ORIGIN[v]);
  // the page is loaded and idle, as when its reader waits for a click (<mail-warm> has had its idle periods)
  await p.waitForTimeout(IDLE_MS);
  return { ctx, p };
};
const framed = (v) => v === 'frame' || v === 'isolated';
try {
  for (const name of EMAILS) {
    if (OPENS) {
      // OPENS=n: the same email (other words each time) n times in a row in a new page: how the code warms up
      const seq = Object.fromEntries(VARIANTS.map((v) => [v, Array.from({ length: OPENS }, () => [])]));
      for (let r = 0; r < RUNS; r++) for (const v of VARIANTS) {
        const { ctx, p } = await fresh(v);
        for (let k = 0; k < OPENS; k++) seq[v][k].push(await open(p, name, true, framed(v)));
        await ctx.close();
      }
      console.log(`\n${name} (${(HTML[name].length / 1024).toFixed(1)} kB), opened ${OPENS} times in a row`);
      for (const v of VARIANTS) for (const k of ['wall', 'script']) console.log(`  ${v.padEnd(11)}${k.padEnd(8)}${seq[v].map((rs) => med(rs.map((x) => x[k])).toFixed(1).padStart(7)).join('')}`);
      continue;
    }
    console.log(`\n${name} (${(HTML[name].length / 1024).toFixed(1)} kB)`.padEnd(34) + KEYS.map((k) => k.padStart(7)).join(''));
    const first = Object.fromEntries(VARIANTS.map((v) => [v, []])), next = Object.fromEntries(VARIANTS.map((v) => [v, []]));
    // the variants in turn within a round, so drift in the machine falls on each alike
    for (let r = 0; r < RUNS; r++) for (const v of VARIANTS) {
      const { ctx, p } = await fresh(v);
      first[v].push(await open(p, name, true, framed(v)));
      for (let k = 0; k < 2; k++) for (const w of CORPUS) await open(p, w, false);
      next[v].push(await open(p, name, true, framed(v)));
      await ctx.close();
    }
    for (const [label, rs] of [['first', first], ['next', next]]) for (const v of VARIANTS) {
      console.log(`  ${label.padEnd(6)}${v.padEnd(10)}${rs[v][0].processes > 1 ? '2 processes' : ''}`.padEnd(33) + row(rs[v]));
      results[`${name} ${label} ${v}`] = Object.fromEntries(KEYS.map((k) => [k, +med(rs[v].map((x) => x[k])).toFixed(2)]));
    }
  }
  if (process.env.JSON_OUT) writeFileSync(process.env.JSON_OUT, JSON.stringify(results, null, 1));
} finally {
  await browser.close(); for (const s of servers) s.close();
  for (const a of Object.values(APPS)) a.remove();
}
