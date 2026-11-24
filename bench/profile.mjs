// Where the script time of one email goes: the reader page of bench/html.mjs (mail.parse in a let, <mail-body>),
// built unminified, with V8's sampling profiler around one message.
//
//   node --experimental-strip-types bench/profile.mjs [email=newsletter] [which=first|next] [runs=5] [top=40]
// WARM=1: with <mail-warm> on the page; IDLE=<ms>: how long the loaded page waits before its first message (300).
//
// `first`: the first message opened in a loaded page (cold code: the time includes compiling and the
// interpreter); `next`: after the corpus was opened twice. Self time per function and per module of the bundle,
// summed over the runs' samples, in ms per message. The sampler slows the page down: read the shares, and the
// totals of bench/html.mjs.
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';

const PKG = resolve(process.env.BASE ?? join(import.meta.dirname, '..'));
const [email = 'newsletter', which = 'next', runsArg = '5', topArg = '40'] = process.argv.slice(2);
const CORPUS = ['reply', 'receipt', 'outlook', 'newsletter', 'digest'];
const HTML = Object.fromEntries(CORPUS.map((n) => [n, readFileSync(join(import.meta.dirname, 'corpus', n + '.html'), 'utf8')]));

const root = mkdtempSync(join(tmpdir(), 'sinter-mail-profile-'));
const files = {
  'index.html': `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>reader</title></head>\n<body>\n<main data-sn-state="{ n: 0 }">
  <button id="next" data-sn-on-click="n++">next</button>
  <sn-resource name="msg" call="bench.body(n)" when="n" type="{ n: number; html: string }"></sn-resource>
  ${process.env.WARM ? '<mail-warm></mail-warm>' : ''}<div class="reader" data-sn-let="{ body: msg ? mail.parse(msg.html, { images: 'proxy', proxy: '/api/email/proxy-image?url={url}', cid: '/api/email/proxy-image?uid=1&cid={cid}' }) : null }"><mail-body id="message" data-sn-with="{ body }"></mail-body></div>
</main>\n</body>\n</html>\n`,
  'src/sinter.helpers.ts': "export * as mail from '@tiavision/sinter-mail';\n",
  'src/sinter.types.ts': "export type { Body, Element } from '@tiavision/sinter-mail';\n",
  'src/sinter.actions.ts': "export * as bench from './bench.ts';\n",
  'src/bench.ts': "export async function body(n: number, ctx: { signal: AbortSignal }) {\n  const r = await fetch('/api/message?n=' + n, { signal: ctx.signal });\n  return { n, html: ((await r.json()) as { html: string }).html };\n}\n",
};
for (const [f, s] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), s); }
for (const d of ['@tiaforge-ui', '@tiavision']) mkdirSync(join(root, 'node_modules', d), { recursive: true });
symlinkSync(PKG, join(root, 'node_modules/@tiavision/sinter-mail'), 'dir');
symlinkSync(realpathSync(join(PKG, 'node_modules/@tiaforge-ui/sinter')), join(root, 'node_modules/@tiaforge-ui/sinter'), 'dir');
const sinter = (await import(join(PKG, 'node_modules/@tiaforge-ui/sinter/dist/vite.js'))).default;
await build({ root, logLevel: 'silent', plugins: [sinter({ libraries: ['@tiavision/sinter-mail'] })], build: { outDir: join(root, 'dist'), emptyOutDir: true, minify: false } });

// the bundle's modules by line: rolldown writes `//#region <path>` before each
const asset = readdirSync(join(root, 'dist/assets')).find((f) => f.endsWith('.js'));
const regions = [];
readFileSync(join(root, 'dist/assets', asset), 'utf8').split('\n').forEach((l, i) => { const m = /^\/\/#region (.*)$/.exec(l); if (m) regions.push([i, m[1].replace(/^.*node_modules\/(@[^/]+\/[^/]+)\//, '$1/').replace(/^.*\/sinter-mail\/sinter\//, 'sinter-mail/').replace(/^.*\/sinter\/dist\//, 'sinter/')]); });
const moduleOf = (line) => { let r = '(bundle)'; for (const [i, name] of regions) { if (i > line) break; r = name; } return r; };

let current = email;
const server = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/api/message') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ html: HTML[current] + `<i>${u.searchParams.get('n')}</i>` })); }
  if (u.pathname === '/api/email/proxy-image') { res.setHeader('Content-Type', 'image/gif'); return res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')); }
  try { const p = u.pathname === '/' ? '/index.html' : u.pathname; const b = readFileSync(join(root, 'dist', p)); res.setHeader('Content-Type', p.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(b); }
  catch { res.statusCode = 404; res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] });
const self = new Map(), mods = new Map(), incl = new Map();
let total = 0;
const open = async (p, name) => {
  current = name;
  const before = await p.evaluate(() => document.querySelector('#message').lastElementChild?.textContent ?? '');
  await p.click('#next');
  await p.waitForFunction((b) => { const t = document.querySelector('#message').lastElementChild?.textContent ?? ''; return t !== b && t !== ''; }, before, { polling: 10 });
};
try {
  for (let r = 0; r < +runsArg; r++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await p.goto(url);
    await p.waitForTimeout(+(process.env.IDLE ?? 300));
    if (which === 'next') for (let k = 0; k < 2; k++) for (const w of CORPUS) await open(p, w);
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 50 });
    await cdp.send('Profiler.start');
    await open(p, email);
    await p.waitForTimeout(50);
    const { profile } = await cdp.send('Profiler.stop');
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    // inclusive time: each node's own samples, added to every distinct function on its path to the root
    const own = new Map(), parent = new Map();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    profile.samples.forEach((id, i) => own.set(id, (own.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000));
    for (const [id, t] of own) {
      const seen = new Set();
      for (let k = id; k !== undefined; k = parent.get(k)) {
        const f = byId.get(k).callFrame, name = `${f.functionName || '(anonymous)'}${f.url.includes('/assets/') ? ':' + (f.lineNumber + 1) : ''}`;
        if (f.functionName === '(idle)' || f.functionName === '(root)' || f.functionName === '(program)' || seen.has(name)) continue;
        seen.add(name); incl.set(name, (incl.get(name) ?? 0) + t);
      }
    }
    profile.samples.forEach((id, i) => {
      const n = byId.get(id), dt = (profile.timeDeltas[i] ?? 0) / 1000, f = n.callFrame;
      if (f.functionName === '(idle)') return;
      const inBundle = f.url.includes('/assets/');
      const mod = inBundle ? moduleOf(f.lineNumber) : f.url ? '(other script)' : f.functionName.startsWith('(') ? f.functionName : '(native)';
      const key = `${f.functionName || '(anonymous)'}  ${inBundle ? mod + ':' + (f.lineNumber + 1) : ''}`;
      self.set(key, (self.get(key) ?? 0) + dt); mods.set(mod, (mods.get(mod) ?? 0) + dt); total += dt;
    });
    await ctx.close();
  }
} finally {
  await browser.close(); server.close(); rmSync(root, { recursive: true, force: true });
}
const per = (v) => (v / +runsArg).toFixed(2).padStart(7);
console.log(`${email}, ${which}: ${per(total)} ms of samples per message (${runsArg} runs)\n\nby module`);
for (const [k, v] of [...mods].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(per(v), `${(100 * v / total).toFixed(1).padStart(5)}%`, k);
console.log('\nby function (inclusive)');
for (const [k, v] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, +topArg)) console.log(per(v), `${(100 * v / total).toFixed(1).padStart(5)}%`, k);
console.log('\nby function (self time)');
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, +topArg)) console.log(per(v), `${(100 * v / total).toFixed(1).padStart(5)}%`, k);
