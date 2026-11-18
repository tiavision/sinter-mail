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

test('mail.progressive numbers the nodes in document order, each element with the last number of its subtree', async () => {
  const { progressive } = await import('../sinter/tree.js');
  const body = { type: 'body', style: {}, images: { origins: [] }, children: [
    { type: 'element', tag: 'div', attrs: {}, style: {}, children: [{ type: 'text', value: 'a' }, { type: 'element', tag: 'b', attrs: {}, style: {}, children: [{ type: 'text', value: 'b' }] }] },
    { type: 'text', value: 'c' },
  ] } as const;
  const b = progressive(structuredClone(body) as never, 3) as unknown as typeof body & { head: number };
  const [div, c] = b.children as unknown as [{ n: number; z: number; children: Array<{ n: number; z?: number; children?: Array<{ n: number }> }> }, { n: number }];
  expect([div.n, div.z, div.children[0]!.n, div.children[1]!.n, div.children[1]!.z, div.children[1]!.children![0]!.n, c.n]).toEqual([0, 3, 1, 2, 3, 3, 4]);
  expect(b.head).toBe(3);
  // deep trees: no recursion
  let deep: any = { type: 'text', value: 'x' };
  for (let i = 0; i < 50_000; i++) deep = { type: 'element', tag: 'span', attrs: {}, style: {}, children: [deep] };
  const d = progressive({ type: 'body', style: {}, images: { origins: [] }, children: [deep] } as never);
  expect((d.children[0] as { z: number }).z).toBe(50_000);
});
