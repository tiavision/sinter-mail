// An email whose tree is a file in the repo: the components are expanded over the `file:` resource at build
// time into plain HTML with inline styles, and the page ships no JavaScript (proposal, sections 6, 7, 9).
// The expected HTML is written from the tree here, by the rules the components follow: the tag's attributes
// in the table's order (sinter/tags.ts, attrsOf), the id prefixed, target and rel on links, the tag's
// properties in the table's order, the parts' classes, the children with no whitespace added.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '@tiaforge-ui/sinter/vite';
import { TAGS, attrsOf } from '../sinter/tags.js';
import type { Body, Element, Node } from '../sinter/sinter.types.js';
import { app, elements, page, PKG } from './app.js';

const TREE = readFileSync(join(PKG, 'fixtures/trees/static.json'), 'utf8');
const DEEP = readFileSync(join(PKG, 'fixtures/trees/all.json'), 'utf8');
const body = JSON.parse(TREE) as Body;
const PAGE = page(`<sn-resource name="mail" src="file:./tree.json" type="Body"></sn-resource>
<main><mail-body id="message" data-sn-prop="{ body: mail }"></mail-body></main>`);

// both slots filled, as in fixtures/fills.html
const FILLS = page(`<sn-resource name="mail" src="file:./tree.json" type="Body"></sn-resource>
<main><mail-body id="message" data-sn-prop="{ body: mail }">
  <a slot="link" class="out" target="_blank" rel="noopener noreferrer nofollow" data-sn-attr="{ href: $slot.node.attrs.href }"><slot></slot></a>
  <template slot="image" data-sn-if="$slot.node.attrs.src"><img loading="lazy" data-sn-attr="{ src: $slot.node.attrs.src, alt: $slot.node.attrs.alt, srcset: null }"></template>
  <template data-sn-else><span class="blocked" data-sn-text="$slot.node.attrs.alt ?? 'image'"></span></template>
</mail-body></main>`);

const apps = {
  tree: app({ 'tree.json': TREE, 'index.html': PAGE }),
  fills: app({ 'tree.json': TREE, 'index.html': FILLS }),
  deep: app({ 'tree.json': DEEP, 'index.html': PAGE }),
};
const out: Record<string, { html: string; js: string[]; error: string | null }> = {};
beforeAll(async () => {
  for (const [name, a] of Object.entries(apps)) {
    let error: string | null = null;
    try {
      await build({ root: a.root, logLevel: 'silent', plugins: [sinter({ components: ['@tiaforge-ui/sinter-mail'], static: ['index.html'] })], build: { outDir: join(a.root, 'dist'), emptyOutDir: true } });
    } catch (e) { error = (e as Error).message; }
    const dist = join(a.root, 'dist');
    out[name] = {
      html: existsSync(join(dist, 'index.html')) ? readFileSync(join(dist, 'index.html'), 'utf8') : '',
      js: existsSync(join(dist, 'assets')) ? readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js')) : [],
      error,
    };
  }
});
afterAll(() => { for (const a of Object.values(apps)) a.remove(); });

const VOID = new Set(['br', 'col', 'hr', 'img', 'wbr']);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');
/** the HTML the components write for a node */
function html(n: Node): string {
  if (n.type === 'text') return esc(n.value);
  const attrs = attrsOf(n.tag).flatMap((a) => (n.attrs[a] === undefined ? [] : [` ${a}="${escAttr(a === 'id' ? `mail-${n.attrs[a]}` : n.attrs[a]!)}"`]));
  const style = TAGS[n.tag].props.flatMap((p) => (n.style[p] === undefined ? [] : [`${p}: ${n.style[p]}`])).join('; ');
  const cls = n.part ? ` class="mail-${n.part}"` : '';
  const open = `<${n.tag}${n.tag === 'a' ? ' target="_blank" rel="noopener noreferrer"' : ''}${attrs.join('')}${cls}${style ? ` style="${escAttr(style)}"` : ''}>`;
  return VOID.has(n.tag) ? open : `${open}${n.children.map(html).join('')}</${n.tag}>`;
}
const noScript = (s: string) => s.replace(/<script type="speculationrules">[^<]*<\/script>/, '');
/** the rendered body: what is inside <div class="mail"> */
const mail = (s: string) => /<div class="mail" id="message" style="[^"]*">([\s\S]*)<\/div><\/main>/.exec(s)?.[1] ?? '';

test('a static page: the tree folds, and the page ships no JavaScript', () => {
  const { html: page, js, error } = out.tree!;
  expect(error).toBe(null);
  expect(js).toEqual([]);
  // no script but the speculation rules sinter writes for prefetching internal links; no anchor, no template
  expect(noScript(page)).not.toMatch(/<script|<template|<!--/);
});

test('the HTML is the tree: each element, its attributes and inline styles, links, ids, images, parts', () => {
  const page = out.tree!.html;
  // the root carries the body's own style and flow-root
  expect(page).toContain('<div class="mail" id="message" style="display: flow-root; color: rgb(34, 34, 34); font-family: Arial, sans-serif; background-color: rgb(238, 238, 238)">');
  expect(mail(page)).toBe(body.children.map(html).join(''));
  // spot checks of what the expected HTML encodes
  expect(page).toContain('<a target="_blank" rel="noopener noreferrer" href="https://example.com/news" style="color: rgb(0, 102, 204); text-decoration: none">News</a>');
  expect(page).toContain('<table id="mail-top" ');
  expect(page).toContain('<p id="mail-bottom"><a target="_blank" rel="noopener noreferrer" href="#mail-top">Back to top</a>');
  // a blocked image: no src, its box kept; no image is given a srcset or a <picture>
  expect(page).toContain('<img alt="Acme Weekly" width="200" height="50" style="display: block; width: 200px; height: 50px; border-top-width: 0px">');
  expect(page).not.toMatch(/srcset|<picture/);
  expect(page).toContain('<blockquote cite="https://example.com/original" class="mail-quote" ');
  expect(page).toContain('<div class="mail-signature" style="color: rgb(102, 102, 102); font-size: 12px">-- <br>Ada, Acme</div>');
});

test('every tag of the table renders, and the page parses back into the same tree', () => {
  const tags = new Set([...body.children.flatMap((c) => [...elements(c)])].map((e) => e.tag));
  expect([...tags].sort()).toEqual(Object.keys(TAGS).sort());
  // as a browser parses the built page: the same elements, in the same order, with no text between tags added
  const doc = new JSDOM(page()).window.document;
  const root = doc.querySelector('#message')!;
  const shape = (n: ChildNode): unknown => (n.nodeType === 3 ? (n as Text).data : [(n as globalThis.Element).localName, ...[...n.childNodes].map(shape)]);
  const want = (n: Node): unknown => (n.type === 'text' ? n.value : [n.tag, ...(n as Element).children.map(want)]);
  expect([...root.childNodes].map(shape)).toEqual(body.children.map(want));
  function page() { return out.tree!.html; }
});

test('whitespace-free: no text between two tags that the tree does not have', () => {
  const m = mail(out.tree!.html);
  const between = [...m.matchAll(/>(\s+)</g)].map((x) => x[1]);
  // the tree's own whitespace-only texts (`<b>Tea</b> <small>`), and nothing else
  const own: string[] = [];
  for (const e of body.children.flatMap((c) => [...elements(c)])) {
    e.children.forEach((c, i) => { if (c.type === 'text' && !c.value.trim() && i > 0 && i < e.children.length - 1) own.push(c.value); });
  }
  expect(own.length).toBeGreaterThan(0);
  expect(between).toEqual(own);
});

test('the slots: a fill replaces every link and every image, and folds with the tree', () => {
  const { html: page, js, error } = out.fills!;
  expect(error).toBe(null);
  expect(js).toEqual([]);
  expect(noScript(page)).not.toMatch(/<script|<template|<!--/);
  const links = [...elements({ type: 'body', style: {}, images: { origins: [] }, children: body.children })].filter((e) => e.tag === 'a');
  expect(page.match(/<a class="out" target="_blank" rel="noopener noreferrer nofollow" href="[^"]*">/g)).toHaveLength(links.length);
  // the link's children, through <slot></slot>
  expect(page).toContain('<a class="out" target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/news">News</a>');
  // a blocked image is the fill's placeholder, a kept one the fill's <img>
  expect(page).toContain('<span class="blocked">Acme Weekly</span>');
  expect(page).toContain('<img loading="lazy" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="A pixel">');
  expect(page).not.toContain('noopener noreferrer" href');
});

// sinter 0.19 expands a constant tree at build time only when each prop is plain data at most 20 objects
// deep (`plainData` in its compiler), which is about 9 elements of an email: a newsletter with nested tables
// is deeper, so its page keeps the tree in the browser. When sinter lifts the bound, this test fails: then
// fold the deep fixture as the shallow one above.
test('a tree deeper than sinter folds (all.json, 12 elements deep) is left to the browser: SN322 on a static page', () => {
  expect(out.deep!.error).toMatch(/SN322 ships-javascript/);
});
