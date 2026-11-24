// mail.parse alone, in Node: this checkout against another one (a change against what it changes), or by itself.
//
//   node bench/parse.mjs [other checkout] [emails=all] [cold runs=12]
//
// Each checkout's parse.ts is bundled (Vite, unminified) and both run in one process, by turns:
//   same    with another checkout: the trees of both, compared (every email of bench/corpus and test/corpus under
//           four option sets, and inputs that are awkward on purpose), JSON-equal, key order included, and frozen
//           at every depth; and the raw trees of the HTML parser. A change that is only faster prints
//           "... identical"; one that is meant to change a tree prints where
//   warm    median ms per parse after the corpus was parsed 40 times: the whole parse, and its parts (the HTML
//           parser, the cascade, the rest: the sanitized tree)
//   cold    median ms of the first parse of that email in a new process (the module already imported): what
//           the first email of a session costs before the browser has compiled anything
// The other checkout needs `node_modules` (a link to this one's will do: `git worktree add ../base <commit> &&
// ln -s $PWD/node_modules ../base/node_modules`). bench/html.mjs measures the same in Chromium, to the paint.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PKG = resolve(import.meta.dirname, '..');
const CORPUS = ['reply', 'receipt', 'outlook', 'newsletter', 'digest'];
const HTML = Object.fromEntries(CORPUS.map((n) => [n, readFileSync(join(PKG, 'bench/corpus', n + '.html'), 'utf8')]));
const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
// another source each time, different from its first characters on (a comment before the doctype changes nothing
// in the tree), and flat, as a string from JSON.parse is
const src = (name, i) => Buffer.from(`<!--${i}-->` + HTML[name]).toString();

// a child of this script: the first parse of one email
if (process.argv[2] === '--cold') {
  const { parse } = await import(pathToFileURL(process.argv[3]).href);
  const s = src(process.argv[4], 1), t = performance.now();
  parse(s, { images: 'allow' });
  console.log(performance.now() - t);
  process.exit(0);
}

const [otherArg = '', emailsArg = 'all', coldArg = '12'] = process.argv.slice(2);
const OTHER = otherArg ? resolve(otherArg) : null;
const EMAILS = emailsArg === 'all' ? CORPUS : emailsArg.split(',');
const out = mkdtempSync(join(tmpdir(), 'sinter-mail-parse-'));

/** `pkg`'s parse.ts, the HTML parser and the cascade as one module */
async function bundle(pkg, name) {
  const { build } = await import(pathToFileURL(join(PKG, 'node_modules/vite/dist/node/index.js')).href);
  const entry = join(out, `${name}.ts`);
  writeFileSync(entry, `export { parse } from '${pkg}/sinter/parse.ts';\nexport { parseHTML, resolve } from '${pkg}/sinter/engine.ts';\n`);
  await build({
    root: pkg, logLevel: 'error', configFile: false, resolve: { alias: { '@tiavision/sinter-mail/parser': `${pkg}/sinter/engine.ts` } },
    build: { lib: { entry: { [name]: entry }, formats: ['es'] }, outDir: join(out, name), emptyOutDir: true, minify: false, rollupOptions: { external: [/^@tiaforge-ui\/sinter/] } },
  });
  return join(out, name, `${name}.js`);
}

try {
  const files = { here: await bundle(PKG, 'here'), ...(OTHER ? { other: await bundle(OTHER, 'other') } : {}) };
  const L = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([k, f]) => [k, await import(pathToFileURL(f).href)])));
  const KEYS = Object.keys(L).reverse(); // the other checkout first, as the one before

  if (OTHER) {
    const docs = [];
    for (const d of ['bench/corpus', 'test/corpus']) for (const f of readdirSync(join(PKG, d)).filter((f) => f.endsWith('.html'))) docs.push([f, readFileSync(join(PKG, d, f), 'utf8')]);
    [
      '', 'plain', '<p>a<p>b<table><tr><td>x<td>y</table><b><i>mis</b>nested</i>', '<svg><circle/><foreignObject><p>in</p></foreignObject></svg><math><mi>x</mi></math>after',
      '<template><p>t</p></template><p>after template', '<style>p{color:red}@media (max-width:480px){p{color:blue!important}}@media (prefers-color-scheme:dark){p{color:#fff;background:#000}}</style><p class=a id=b style="color:green;margin:1px 2px">x</p>',
      '<a href="#t">t</a><a name="t">target</a><p id="t">dup</p><a href="#none">n</a><a href="javascript:alert(1)">j</a><a href=" HTTPS://EXAMPLE.com/a b?x=1&amp;y=2#f ">u</a>',
      '<img src="cid:logo@x" width=10 height=10><img src="data:image/png;base64,AAAA"><img src="https://t.example/p.gif" width=1 height=1><img src="http://a.example/x.png?a=1&b=2" style="width:50%">',
      '<div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> x</div><div>old</div>', '<div class="gmail_quote"><blockquote type="cite">q</blockquote></div><div class="gmail_signature">s</div>',
      '<table bgcolor=#eee cellpadding=4 cellspacing=2 border=1 width=100% align=center><caption>c</caption><colgroup><col span=2 width=50></colgroup><thead><tr><th scope=col colspan=2>h</th></tr></thead><tr><td valign=top nowrap>x</td></tr></table>',
      '<font color=red face="Arial, sans" size=5>f</font><center>c</center><body text="#333" link=blue bgcolor=white>x&nbsp;&amp;&copy;&notin;&#x41;&#128512;&bogus;&amp', '<p style="position:fixed;background:url(http://x/);color:red !important;margin:-4px;width:calc(1px + 2px);font:italic bold 12px/1.5 Georgia, serif">s</p>',
      '<ol start=3 reversed type=a><li value=7>x</ol><details open><summary>s</summary>d</details><o:p>o</o:p><big>b</big><script>alert(1)</script><form><input value=1>f</form>',
      '<!doctype html><html lang=en dir=rtl style="color-scheme: light dark"><head><meta name="color-scheme" content="light dark"><title>t</title></head><body style="margin:0;font-family:Arial">x',
      'a\r\nb\rc\0d<p title="a\0b&amp;c">x</p><textarea>\n<b>raw</b></textarea><title>&amp;t</title><xmp><b></xmp><plaintext>rest <b>',
      '<div>'.repeat(300) + 'deep' + '</div>'.repeat(300), '<b>'.repeat(40) + '<p>x' + '<p>y', '<table><tr><td><table><tr><td><table><tr><td>n</table></table></table>x<td>stray',
    ].forEach((h, i) => docs.push([`input ${i}`, h]));
    const OPTS = [undefined, { images: 'allow' }, { images: 'proxy', proxy: '/p?u={url}', cid: '/c?id={cid}' }, { images: 'allow', media: 'narrow', cid: { 'logo@x': 'data:image/png;base64,AAAA' }, dataImages: 0 }];
    const frozen = (b) => { const st = [b]; while (st.length) { const n = st.pop(); if (!Object.isFrozen(n)) return false; if (n.type !== 'text') { if (!Object.isFrozen(n.style) || !Object.isFrozen(n.children) || (n.attrs && !Object.isFrozen(n.attrs))) return false; st.push(...n.children); } } return true; };
    const raw = (e) => (e.type === 'text' ? JSON.stringify(e.value) : `<${e.tag}${e.attrs.map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join('')}>${e.children.map(raw).join('')}</>`);
    const run = (f) => { try { return f(); } catch (e) { return `throws: ${e.message}`; } };
    let bad = 0, n = 0;
    for (const [name, html] of docs) for (const o of OPTS) {
      n++;
      const tree = run(() => L.here.parse(html, o));
      const a = run(() => JSON.stringify(L.other.parse(html, o))), b = typeof tree === 'string' ? tree : JSON.stringify(tree);
      if (a !== b) { bad++; let i = 0; while (a[i] === b[i]) i++; console.log(`different: ${name} ${JSON.stringify(o) ?? ''}\n  other …${a.slice(Math.max(0, i - 80), i + 120)}\n  here  …${b.slice(Math.max(0, i - 80), i + 120)}`); }
      else if (typeof tree !== 'string' && !frozen(tree)) { bad++; console.log(`not frozen: ${name}`); }
      if (o === undefined && run(() => raw(L.other.parseHTML(html))) !== run(() => raw(L.here.parseHTML(html)))) { bad++; console.log(`the raw tree differs: ${name}`); }
    }
    console.log(bad ? `same: ${bad} of ${n} parses differ\n` : `same: ${n} parses identical, frozen\n`);
  }

  for (let i = 0; i < 40; i++) for (const f of CORPUS) for (const k of KEYS) L[k].parse(src(f, 'w' + i), { images: 'allow' });
  const f2 = (x) => x.toFixed(2).padStart(7);
  const cols = (get) => KEYS.map((k) => f2(get(k))).join('') + (KEYS.length > 1 ? `${(get('here') / get('other')).toFixed(2).padStart(6)} ` : ' ');
  console.log(`ms, medians${OTHER ? `; each pair: ${OTHER}, this checkout, and their ratio` : ''}`);
  console.log(`${''.padEnd(20)}${['parse', 'html', 'cascade', 'rest', 'cold'].map((h) => h.padStart(KEYS.length > 1 ? 14 : 7).padEnd(KEYS.length > 1 ? 21 : 8)).join('')}`);
  for (const f of EMAILS) {
    const T = Object.fromEntries(KEYS.map((k) => [k, { t: [], h: [], c: [] }]));
    for (let i = 0; i < 80; i++) for (const k of i % 2 ? KEYS : [...KEYS].reverse()) {
      const s = src(f, i), m = L[k];
      let a = performance.now(); m.parse(s, { images: 'allow' }); T[k].t.push(performance.now() - a);
      a = performance.now(); const root = m.parseHTML(s); T[k].h.push(performance.now() - a);
      a = performance.now(); m.resolve(root, { media: 'wide' }); T[k].c.push(performance.now() - a);
    }
    const cold = Object.fromEntries(KEYS.map((k) => [k, []]));
    for (let i = 0; i < +coldArg; i++) for (const k of KEYS) cold[k].push(+execFileSync(process.execPath, [import.meta.filename, '--cold', files[k], f], { encoding: 'utf8' }));
    const M = (k, x) => med(T[k][x]);
    console.log(`${f.padEnd(11)}${`${(HTML[f].length / 1024).toFixed(0)} kB`.padStart(7)}  ${cols((k) => M(k, 't'))}${cols((k) => M(k, 'h'))}${cols((k) => M(k, 'c'))}${cols((k) => M(k, 't') - M(k, 'h') - M(k, 'c'))}${+coldArg ? cols((k) => med(cold[k])) : ''}`);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
