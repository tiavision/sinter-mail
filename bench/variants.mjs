// The benchmark's variants. Each `setup(ctx)` returns the app's files, its build options, what the API
// answers, the page's policy, and how to tell the email is rendered (`done(expect)` in the page).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PKG } from './apps.mjs';

/** the tree the server sends for message `n` (1 by default): mail.parse run in Node, as an API runs it */
const parsed = new Map();
let parseFn;
async function tree(ctx, n = 1) {
  parseFn ??= (await import((await ctx.bundle('sinter/parse.ts', { minify: false })).path)).parse;
  if (!parsed.has(n)) parsed.set(n, parseFn(ctx.htmlOf(n)));
  return parsed.get(n);
}
/** the API's answers, message by message: the tree, or the HTML */
// messages 1 to ctx.messages (2 unless the run asks for more: bench/switch.mjs), answered as JSON
const treeApi = async (ctx) => {
  const all = [];
  for (let n = 1; n <= (ctx.messages ?? 2); n++) all.push(JSON.stringify(await tree(ctx, n)));
  return (n) => all[(n - 1) % all.length];
};
const htmlApi = (ctx) => {
  const all = Array.from({ length: ctx.messages ?? 2 }, (_, i) => JSON.stringify({ html: ctx.htmlOf(i + 1) }));
  return (n) => all[(n - 1) % all.length];
};
const countTree = (b) => { let n = 0; const w = (x) => { if (x.type === 'element') n++; for (const c of x.children ?? []) w(c); }; b.children.forEach(w); return n; };
const rendered = (n) => document.querySelectorAll('#message *').length === n;

// Caley's mail-frame (frontend/src/components/mail-frame.{html,ts}) and its DOMPurify call
// (frontend/src/lib/mail-html.ts), as they are, but the frame always sized to its content (Caley sizes it in
// the narrow layout; the wide one fills the reader): the "sized iframe" of the comparison.
// Caley is not under this repository's licence, so its files are read from a checkout of it
// (`git clone https://git.tia.sh/tia/caley`, beside this repository or at $CALEY), not copied here.
const CALEY_DIR = join(process.env.CALEY ?? join(PKG, '../caley'), 'frontend/src');
function caleyFiles() {
  const read = (f) => readFileSync(join(CALEY_DIR, f), 'utf8');
  const frame = read('components/mail-frame.ts');
  // the one change: size the frame in every layout (Caley's wide layout fills the reader instead)
  const sized = frame.replace('if (!this.#media.matches) {', 'if (false) {');
  if (sized === frame) throw new Error('bench: Caley\'s mail-frame.ts changed; update the patch in bench/variants.mjs');
  const pure = read('lib/mail-html.ts');
  // the component calls Caley's prepareEmailHtml, as Caley's action does before it passes the HTML on
  const call = sized.replace('frame.srcdoc = html;', 'frame.srcdoc = prepareEmailHtml(html);')
    .replace("import { MailFrameComponent } from './mail-frame.html';", "import { MailFrameComponent } from './mail-frame.html';\nimport { prepareEmailHtml } from '../lib/mail-html.ts';");
  if (call === sized) throw new Error('bench: Caley\'s mail-frame.ts changed; update the patch in bench/variants.mjs');
  // renamed app-frame: the mail- prefix is sinter-mail's (SN338)
  const ts = call.replace(/MailFrameComponent/g, 'AppFrameComponent').replace('./mail-frame.html', './app-frame.html').replace('class MailFrame ', 'class AppFrame ');
  return { 'src/lib/mail-html.ts': pure, 'src/components/app-frame.html': read('components/mail-frame.html'), 'src/components/app-frame.ts': ts };
}

export const VARIANTS = {
  iframe: {
    label: "Caley's approach (DOMPurify, then a sized iframe)",
    async setup(ctx) {
      return {
        files: {
          ...caleyFiles(),
          'index.html': ctx.page(`<sn-resource name="message" src="${ctx.src}" type="Message"></sn-resource>\n${ctx.nav}<main><app-frame id="message" data-sn-prop="{ html: message?.html ?? '', isolated: false, label: 'Mail' }"></app-frame></main>`),
        },
        build: { modules: ['dompurify'] },
        api: htmlApi(ctx),
        csp: ctx.CALEY_CSP,
        expect: countTree(await tree(ctx)),
        // the frame's document holds the email (DOMPurify keeps more elements than the tree: its own count) and the frame is sized
        done: () => { const f = document.querySelector('#message iframe'); const d = f?.contentDocument; return !!d && d.readyState === 'complete' && d.body?.querySelectorAll('*').length > 1000 && f.style.height !== ''; },
        count: () => document.querySelector('#message iframe').contentDocument.body.querySelectorAll('*').length,
      };
    },
  },
  tree: {
    label: 'sinter-mail, tree from the API (server ran mail.parse)',
    async setup(ctx) {
      const t = await tree(ctx);
      return {
        files: { 'index.html': ctx.page(`<sn-resource name="message" src="${ctx.src}" type="Body"></sn-resource>\n${ctx.nav}<main><mail-body id="message" data-sn-prop="{ body: message }"></mail-body></main>`) },
        api: await treeApi(ctx), expect: countTree(t), done: rendered,
      };
    },
  },
  html: {
    label: 'sinter-mail, HTML from the API (mail.parse in the browser)',
    async setup(ctx) {
      const t = await tree(ctx);
      return {
        files: { 'index.html': ctx.page(`<sn-resource name="message" src="${ctx.src}" type="Message"></sn-resource>\n${ctx.nav}<main data-sn-let="{ body: message ? mail.parse(message.html) : null }"><mail-body id="message" data-sn-prop="{ body }"></mail-body></main>`) },
        api: htmlApi(ctx), expect: countTree(t), done: rendered,
      };
    },
  },
  'html-lazy': {
    label: 'sinter-mail, HTML from the API, the parser lazy',
    async setup(ctx) {
      const s = await VARIANTS.html.setup(ctx);
      return { ...s, build: { ...s.build, options: { lazy: ['@tiaforge-ui/sinter-mail'] } } };
    },
  },
  floor: {
    label: 'the floor: the same tree built by a minimal DOM loop, no sinter (createElement, setProperty per set property)',
    optional: true,
    async setup(ctx) {
      const t = await tree(ctx);
      return {
        files: {
          'index.html': ctx.page(`${ctx.nav}<main><div id="message" class="mail"></div></main><script type="module" src="/src/floor.js"></script>`),
          'src/floor.js': `const A = { href: 1, colspan: 1, rowspan: 1, width: 1, height: 1, alt: 1, title: 1, dir: 1, lang: 1 };
function el(n) {
  if (n.type === 'text') return document.createTextNode(n.value);
  const e = document.createElement(n.tag);
  for (const k in n.attrs) if (A[k]) e.setAttribute(k, n.attrs[k]);
  for (const k in n.style) e.style.setProperty(k, n.style[k]);
  for (const c of n.children) e.append(el(c));
  return e;
}
const b = await (await fetch('/api/message?n=1')).json();
const root = document.getElementById('message');
for (const k in b.style) root.style.setProperty(k, b.style[k]);
root.append(...b.children.map(el));
`,
        },
        api: await treeApi(ctx), expect: countTree(t), done: rendered,
      };
    },
  },
  'html-hints': {
    label: 'sinter-mail, HTML from the API, the page module with V8 compile hints (//# allFunctionsCalledOnLoad)',
    async setup(ctx) {
      const s = await VARIANTS.html.setup(ctx);
      return { ...s, build: { ...s.build, compileHints: true } };
    },
  },
  'floor-classes': {
    label: 'the floor with classes: each distinct style one rule of a constructed stylesheet (adoptedStyleSheets), each element its class',
    optional: true,
    async setup(ctx) {
      const s = await VARIANTS.floor.setup(ctx);
      return {
        ...s,
        files: {
          ...s.files,
          'src/floor.js': `const A = { href: 1, colspan: 1, rowspan: 1, width: 1, height: 1, alt: 1, title: 1, dir: 1, lang: 1 };
const sheet = new CSSStyleSheet();
document.adoptedStyleSheets = [sheet];
const classes = new Map();
function classOf(style) {
  const key = JSON.stringify(style);
  let c = classes.get(key);
  if (c === undefined) {
    c = 'mail-s' + classes.size;
    const i = sheet.insertRule('.' + c + ' {}', sheet.cssRules.length);
    for (const k in style) sheet.cssRules[i].style.setProperty(k, style[k]);
    classes.set(key, c);
  }
  return c;
}
function el(n) {
  if (n.type === 'text') return document.createTextNode(n.value);
  const e = document.createElement(n.tag);
  for (const k in n.attrs) if (A[k]) e.setAttribute(k, n.attrs[k]);
  for (const k in n.style) { e.className = classOf(n.style); break; }
  for (const c of n.children) e.append(el(c));
  return e;
}
const b = await (await fetch('/api/message?n=1')).json();
const root = document.getElementById('message');
for (const k in b.style) root.style.setProperty(k, b.style[k]);
root.append(...b.children.map(el));
`,
        },
      };
    },
  },
  none: {
    label: 'the same page without the components (for sizes)',
    optional: true,
    async setup(ctx) {
      const t = await tree(ctx);
      return {
        files: { 'index.html': ctx.page(`<sn-resource name="message" src="${ctx.src}" type="Body"></sn-resource>\n${ctx.nav}<main><p id="message" data-sn-text="message?.type"></p></main>`) },
        api: await treeApi(ctx), expect: 0, done: () => document.querySelector('#message')?.textContent === 'body', count: () => 0,
      };
    },
  },
};
