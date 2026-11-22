import type { Tag } from '../sinter/sinter.types.js';
// <mail-body>'s two renderings, the tree built directly by <mail-view>'s script and the generated components, in
// Chromium under `script-src 'self'; style-src 'self'; require-trusted-types-for 'script'`: the same tree gives the
// same elements, attributes and styles (the anchors of <mail-body>'s loops apart), with nothing reported.
import { createServer, type Server } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromium, type Browser } from 'playwright';
import sinter from '@tiaforge-ui/sinter/vite';
import { parse } from '../sinter/parse.js';
import { progressive } from '../sinter/tree.js';
import { app, el, newsletter, page, PKG } from './app.js';

const CSP = "script-src 'self'; style-src 'self'; require-trusted-types-for 'script'";
const a = app({ 'index.html': page('<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n<main><mail-body id="a" data-sn-with="{ body: message, templates: true }"></mail-body><mail-body id="b" data-sn-with="{ body: message }"></mail-body><button id="again" data-sn-on-click="refresh(message)">again</button></main>', `<meta http-equiv="Content-Security-Policy" content="${CSP}">`) });
let server: Server, url = '', browser: Browser, message = 'null';

beforeAll(async () => {
  await build({ root: a.root, logLevel: 'silent', plugins: [sinter({ libraries: ['@tiavision/sinter-mail'] }) as never], build: { outDir: join(a.root, 'dist'), emptyOutDir: true } });
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/api/message') { res.setHeader('Content-Type', 'application/json'); return res.end(message); }
    try {
      const body = readFileSync(join(a.root, 'dist', path === '/' ? '/index.html' : path));
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); server?.close(); a.remove(); });

const corpus = readdirSync(join(PKG, 'test/corpus')).filter((f) => f.endsWith('.html'));
/** what the table does not allow, in a tree an API could send: each must render as the components render it */
const HOSTILE = {
  type: 'body', style: { color: 'red', position: 'fixed' }, images: { blocked: 0, shown: 0 }, children: [
    el('div', { id: 'x', title: 't', onclick: 'alert(1)' } as never, { width: '10px', position: 'fixed', 'background-color': 'url(http://x/)', color: 'red' } as never, [
      el('a', { href: 'javascript:alert(1)' }, {}, ['bad']), el('a', { href: 'https://example.com/', id: 'l' }, { color: 'blue' }, ['good']), el('a', { href: 'DATA:text/html,x' }, {}, ['data']),
      el('img', { src: 'data:image/png;base64,AAAA', alt: 'i', width: '1', height: '1' }, { width: '1px', color: 'red' } as never), el('img', { src: 'javascript:1' }, {}),
      { type: 'element', tag: 'script' as unknown as Tag, attrs: {}, style: {}, children: [{ type: 'text', value: 'alert(1)' }] },
      { type: 'element', tag: 'constructor' as unknown as Tag, attrs: {}, style: {}, children: [] }, { type: 'element', tag: '__proto__' as unknown as Tag, attrs: {}, style: {}, children: [] },
      el('td', {}, { color: 'red' }, ['orphan ', el('b', {}, {}, ['cell'])]), el('span', {}, { display: 'none' }, ['hidden']),
      el('blockquote', { cite: 'https://example.com/q' }, {}, ['quote']), el('blockquote', { cite: 'javascript:1' }, {}, ['q2']),
      { ...el('div', {}, {}, ['sig']), part: 'signature' }, { ...el('blockquote', {}, {}, ['quoted']), part: 'quote' }, { ...el('p', {}, {}, ['no part']), part: 'quote' },
      el('ol', { start: '3', reversed: '', type: 'a' }, { 'list-style-type': 'upper-roman' }, [el('li', { value: '7' }, {}, ['seven'])]),
      el('details', { open: '' }, {}, [el('summary', {}, {}, ['s']), 'd']), el('br', {}, { clear: 'both' }), el('hr', {}, { width: '50%' }), el('wbr'),
      el('table', { role: 'presentation' }, { 'border-collapse': 'collapse' }, [
        'text in a table', el('caption', {}, { 'caption-side': 'bottom' }, ['cap']), el('caption', {}, { display: 'none' }, ['hidden cap']),
        el('colgroup', { span: '2' }, { display: 'none', width: '10px' }, [el('col', { span: '1' }, { width: '5px' }), el('div', {}, { width: '6px' }), 'x']),
        el('thead', {}, {}, [el('tr', {}, {}, [el('th', { scope: 'col', colspan: '2' }, { 'text-align': 'left' }, ['h'])])]),
        el('div', {}, { color: 'red' }, [el('p', {}, { color: 'blue' }, [el('span', {}, {}, ['as a cell']), el('th', { abbr: 'x' }, {}, ['th']), 'text in a row'])]),
        el('tbody', {}, { display: 'none' }, [el('tr', {}, {}, [el('td', {}, {}, ['never'])])]),
        el('tfoot', {}, {}, [el('tr', {}, { display: 'none' }, []), 'text', el('tr', {}, {}, [el('td', {}, { display: 'none' }, ['no']), el('td', { headers: 'a', rowspan: '2' }, {}, ['f'])])]),
      ]),
    ]),
    { type: 'text', value: 'tail' },
  ],
};
const trees: [string, string][] = [
  ['fixtures/trees/all.json', readFileSync(join(PKG, 'fixtures/trees/all.json'), 'utf8')],
  ['fixtures/trees/static.json', readFileSync(join(PKG, 'fixtures/trees/static.json'), 'utf8')],
  ...corpus.map((f): [string, string] => [f, JSON.stringify(parse(readFileSync(join(PKG, 'test/corpus', f), 'utf8'), { images: 'allow' }))]),
  ...corpus.map((f): [string, string] => [`${f} (narrow, numbered)`, JSON.stringify(progressive(parse(readFileSync(join(PKG, 'test/corpus', f), 'utf8'), { media: 'narrow' }), 20))]),
  ['a newsletter of 2,000 elements', JSON.stringify(newsletter(2000))],
  ['a tree the table does not allow', JSON.stringify(HOSTILE)],
];

test('the same tree gives the same DOM as <mail-body>, its anchors apart, under the strict policy with nothing reported', async () => {
  const p = await browser.newPage();
  const errors: string[] = [];
  p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => {
    (window as never as { __v: string[] }).__v = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as never as { __v: string[] }).__v.push(`${e.violatedDirective} ${e.sample}`));
  });
  const read = () => p.evaluate(() => {
    const html = (id: string) => document.getElementById(id)!.outerHTML.replace(/<!--.*?-->/gs, '').replace(/<i hidden=""><\/i>/g, '').replace(/ id="[ab]"/, '').replace(/ data-sn(?:-\w+)?="[^"]*"/g, '');
    // adjacent text nodes are one run in the markup either way
    // which path each took: the templates leave their anchors' comments, the fast path none
    const comments = (id: string) => { let c = 0; const w = document.createTreeWalker(document.getElementById(id)!, NodeFilter.SHOW_COMMENT); while (w.nextNode()) c++; return c; };
    return { a: html('a'), b: html('b'), n: document.querySelectorAll('#b *').length, ca: comments('a'), cb: comments('b') };
  });
  let elements = 0;
  for (const [name, tree] of trees) {
    message = tree;
    await p.goto(url);
    // a progressive body's steps end with the whole body
    await expect.poll(async () => { const r = await read(); return r.a === r.b && r.b.length; }, { message: name, timeout: 20_000 }).toBeTruthy().catch(() => {});
    const r = await read();
    // #a renders through the templates (`templates`), #b through the fast path
    if (r.n > 0) { expect(r.ca, name).toBeGreaterThan(0); expect(r.cb, name).toBe(0); }
    if (r.a !== r.b) { let i = 0; while (r.a[i] === r.b[i]) i++; expect(r.b.slice(Math.max(0, i - 150), i + 150), name).toBe(r.a.slice(Math.max(0, i - 150), i + 150)); }
    elements += r.n;
  }
  expect(elements).toBeGreaterThan(2300);
  // nothing the table does not allow is in the page
  expect(await p.evaluate(() => document.querySelectorAll('#b script, #b [onclick], #b [href^="javascript"], #b [href^="DATA"], #b [src^="javascript"], #b constructor').length)).toBe(0);
  expect(await p.evaluate(() => document.querySelector('#b [id="mail-x"]')!.getAttribute('style'))).toBe('color: red; width: 10px;');
  // a new body renders in place of the one before
  message = trees[0]![1];
  await p.click('#again');
  await expect.poll(async () => { const r = await read(); return r.a === r.b && r.b.includes('mail-top'); }).toBeTruthy();
  // no body: an empty root, as <mail-body>'s
  message = 'null';
  await p.click('#again');
  await expect.poll(async () => { const r = await read(); return r.a === r.b && r.n === 0; }).toBeTruthy();
  expect(await p.evaluate(() => (window as never as { __v: string[] }).__v)).toEqual([]);
  expect(errors).toEqual([]);
  await p.close();
});
