import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { plain } from '../sinter/plain.js';
import { links, text } from '../sinter/tree.js';
import type { Body, Element, Node, Style, Tag } from '../sinter/sinter.types.js';

const t = (value: string): Node => ({ type: 'text', value });
const el = (tag: Tag, children: Node[] = [], style: Style = {}, attrs: Element['attrs'] = {}): Element => ({ type: 'element', tag, attrs, style, children });
const body = (...children: Node[]): Body => ({ type: 'body', style: {}, children, images: { origins: [] } });

test('text: inline runs together, whitespace collapsed, blocks on lines, paragraphs apart', () => {
  // an HTML body's source whitespace collapses
  expect(text(body(t('\n  '), el('div', [t('\n  Hello,  '), el('b', [t('Ann')]), t(' !\n')]), t('\n'), el('p', [t('One')]), el('p', [t('Two'), el('br'), t('  lines')]), el('div', [t('end')])))).toBe('Hello, Ann !\n\nOne\n\nTwo\nlines\n\nend');
  expect(text(body(el('div', [t('a')]), el('div', [t('b')])))).toBe('a\nb');
  expect(text(body(el('span', [t('a')]), el('span', [t(' b ')]), t('c')))).toBe('a b c');
  // a table: cells by tabs, rows by lines
  expect(text(body(el('table', [el('tbody', [el('tr', [el('td', [t(' a ')]), el('td', [t('b')])]), el('tr', [el('td', [t('c')])])])]), t('after')))).toBe('a\tb\nc\n\nafter');
  // lists: an item a line, the list apart
  expect(text(body(t('x'), el('ul', [el('li', [t('one')]), el('li', [t('two')])]), t('y')))).toBe('x\n\none\ntwo\n\ny');
  // br runs stay, but never more than one blank line; none at the ends
  expect(text(body(el('br'), t('a'), el('br'), el('br'), el('br'), el('br'), t('b'), el('br')))).toBe('a\n\nb');
});

test('text: preformatted text as written, display from the resolved style', () => {
  expect(text(body(el('pre', [t('  a\n    b')]), el('div', [t('x  y\n z')], { 'white-space': 'pre-line' })))).toBe('  a\n    b\n\nx y\nz');
  expect(text(body(el('div', [t('hidden')], { display: 'none' }), el('span', [t('a')], { display: 'block' }), el('div', [t('b')], { display: 'inline-block' }), t(' c')))).toBe('a\nb c');
  // white-space normal inside pre collapses again
  expect(text(el('pre', [t('a  b'), el('span', [t('c   d')], { 'white-space': 'normal' })]))).toBe('a  bc d');
});

test('text: nodes, nothing', () => {
  expect(text(t(' as  is '))).toBe(' as  is ');
  expect(text(el('a', [t('link')], {}, { href: 'https://x.example' }))).toBe('link');
  expect(text(null)).toBe('');
  expect(text(undefined)).toBe('');
  expect(text(body())).toBe('');
});

test('text of a plain body: its paragraphs, quotes and signature as written', () => {
  const s = 'Hi,\n\nSee  www.example.com\nsoon.\n\n> quoted\n>> deeper\n-- \nAnn';
  expect(text(plain(s))).toBe('Hi,\n\nSee  www.example.com\nsoon.\n\nquoted\n\ndeeper\n\n-- \nAnn');
});

test('links: every a with an href, in document order, with its text', () => {
  const b = body(
    el('p', [el('a', [t('Home')], {}, { href: 'https://x.example/' }), t(' '), el('a', [t('no href')])]),
    el('table', [el('tbody', [el('tr', [el('td', [el('a', [el('b', [t('Buy')]), t('  now')], {}, { href: 'https://x.example/buy' })])])])]),
    el('a', [], {}, { href: '' }),
  );
  expect(links(b)).toEqual([{ href: 'https://x.example/', text: 'Home' }, { href: 'https://x.example/buy', text: 'Buy now' }]);
  expect(links(plain('mail ann@example.com or\n> https://a.example/x.'))).toEqual([
    { href: 'mailto:ann@example.com', text: 'ann@example.com' }, { href: 'https://a.example/x', text: 'https://a.example/x' },
  ]);
  expect(links(null)).toEqual([]);
  expect(links(body())).toEqual([]);
});

test('deep and long trees: no recursion, linear', () => {
  let n: Node = t('x');
  for (let i = 0; i < 1e5; i++) n = el(i % 2 ? 'div' : 'a', [n], {}, i % 2 ? {} : { href: '#' });
  const start = performance.now();
  expect(text(body(n))).toBe('x');
  expect(text(body(...Array.from({ length: 1e5 }, () => el('br'))))).toBe('');
  expect(text(body(t('a' + ' '.repeat(1e6) + 'b'), el('pre', [t('\n'.repeat(1e6))])))).toBe('a b');
  expect(performance.now() - start).toBeLessThan(1000);
  expect(links(body(...Array.from({ length: 1e4 }, () => el('a', [t('l')], {}, { href: '/x' }))))).toHaveLength(1e4);
});

test('tree.ts imports no parser', () => {
  const src = readFileSync(new URL('../sinter/tree.ts', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  expect(imports).toEqual(['./sinter.types.js']);
});

test('mail.progressive, deprecated, gives the body back as it is', async () => {
  const { progressive } = await import('../sinter/tree.js');
  const { parse } = await import('../sinter/parse.js');
  const tree = parse('<p>One <b>two</b></p>');
  expect(progressive(tree)).toBe(tree);
  expect(progressive(tree, 3)).toBe(tree);
});

test('mail.unquoted: the reply without its history, a copy, the same for the same tree; whole when nothing would be left', async () => {
  const { unquoted } = await import('../sinter/tree.js');
  const { parse } = await import('../sinter/parse.js');
  const reply = parse('<div>Yes, Friday.</div><div class="gmail_quote"><div class="gmail_attr">On Monday Sam wrote:</div><blockquote class="gmail_quote">Lunch? <img src="data:image/png;base64,iVBORw0KGgo=" alt="map" width="20" height="20"></blockquote></div>');
  expect(reply.quotes).toBe(true);
  const short = unquoted(reply);
  expect(text(short)).toBe('Yes, Friday.');
  expect(short.quotes).toBeUndefined();
  expect(text(reply)).toContain('Lunch?');
  expect(unquoted(reply)).toBe(short);
  expect(unquoted(short)).toBe(short);
  // nothing quoted, or nothing but the quote (a forward without a word): the body itself
  const plainOne = parse('<p>Hello</p>');
  expect(unquoted(plainOne)).toBe(plainOne);
  const forward = parse('<div class="gmail_quote">---------- Forwarded message ---------<br>The agenda</div>');
  expect(unquoted(forward)).toBe(forward);
  // mail.plain's quotes too
  const p = plain('Agreed.\n\n> Shall we?\n> Yes');
  expect(p.quotes).toBe(true);
  expect(text(unquoted(p))).toBe('Agreed.');
});
