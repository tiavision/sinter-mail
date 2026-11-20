// The components and the tag table agree: one component per tag that renders on its own, the table's parts
// inside mail-table, one dispatch (mail-node) whose map names every tag, and the `Tag` union of
// sinter.types.ts equal to the table's tags. The generated files are what scripts/build-components.mjs
// writes, and none has whitespace between tags.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { TAGS } from '../sinter/tags.js';
import { PKG } from './app.js';

const DIR = join(PKG, 'sinter/components');
const read = (f: string) => readFileSync(f, 'utf8');
const internal = readdirSync(join(DIR, 'internal')).filter((f) => f.endsWith('.html')).sort();
const files = [...readdirSync(DIR).filter((f) => f.endsWith('.html')).map((f) => join(DIR, f)), ...internal.map((f) => join(DIR, 'internal', f))];
const tags = Object.keys(TAGS).sort();
const own = tags.filter((t) => !TAGS[t as keyof typeof TAGS].inTable);
const inTable = tags.filter((t) => TAGS[t as keyof typeof TAGS].inTable);
/** the markup of a component file, after its leading comment */
const markup = (f: string) => read(f).replace(/^<!--[\s\S]*?-->\n/, '').replace(/\n<style>[\s\S]*<\/style>\n$/, '\n');

test('the Tag union of sinter.types.ts is the table\'s tags', () => {
  const union = /export type Tag =([^;]+);/.exec(read(join(PKG, 'sinter/sinter.types.ts')))![1]!;
  expect([...union.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]).sort()).toEqual(tags);
});

test('one component per tag that renders on its own, the dispatch and the orphan: no other file', () => {
  expect(internal).toEqual([...own.map((t) => `mail-${t}.html`), 'mail-node.html', 'mail-orphan.html', 'mail-steps.html'].sort());
  // a table's parts have no component: mail-table renders them
  for (const t of inTable) expect(internal).not.toContain(`mail-${t}.html`);
});

test('mail-node maps every tag: its own component, or a table part to mail-orphan; it is the only choice', () => {
  const use = /<sn-component use="\{ ([^}]*) \}\[node\.tag\]" data-sn-prop="\{ node \}"><\/sn-component>/.exec(read(join(DIR, 'internal/mail-node.html')))![1]!;
  const map = Object.fromEntries(use.split(', ').map((e) => e.split(': ')).map(([k, v]) => [k!.replace(/'/g, ''), v!.slice(1, -1)]));
  expect(Object.keys(map).sort()).toEqual(tags);
  for (const t of own) expect(map[t]).toBe(`mail-${t}`);
  for (const t of inTable) expect(map[t]).toBe('mail-orphan');
  const choosing = files.filter((f) => read(f).includes('<sn-component')).map((f) => f.slice(DIR.length + 1));
  expect(choosing).toEqual(['internal/mail-node.html']);
});

test('each component renders its own tag as its root (a link and an image inside their slot)', () => {
  for (const t of own) {
    const m = markup(join(DIR, 'internal', `mail-${t}.html`));
    const root = /^<template data-sn-component="\{ node: Element \}">([\s\S]*)<\/template>\n$/.exec(m)![1]!;
    const inner = t === 'a' ? /^<slot name="link" data-sn-prop="\{ node \}">([\s\S]*)<\/slot>$/.exec(root)![1]! : t === 'img' ? /^<slot name="image" data-sn-prop="\{ node \}">([\s\S]*)<\/slot>$/.exec(root)![1]! : root;
    // the element itself, its id bound only when it has one
    expect(inner, t).toMatch(new RegExp(`^<${t}[ >]`));
    expect(inner, t).not.toMatch(/^<template data-sn-if="node\.attrs\.id">/);
  }
  // the table's parts are literal in mail-table
  const table = read(join(DIR, 'internal/mail-table.html'));
  for (const t of [...inTable, 'table']) expect(table, t).toMatch(new RegExp(`<${t}[ >]`));
});

test('every loop over children renders text runs itself and passes every other node to mail-node', () => {
  // the children, keyed by the node's number (mail.progressive) or else their position: an element's, or <mail-body>'s
  // (the body's, or in a progressive render the step's tree)
  const KIDS = String.raw`body \? body\.children : \[\]|shown \? shown\.children : \[\]|\w+\.children`;
  const RUN = new RegExp(String.raw`<template data-sn-for="\((\w+), \1i\) in (?:${KIDS})" data-sn-key="\1\.n \?\? \1i"><template data-sn-if="\1\.type === 'text'"><template data-sn-text="\1\.value"><\/template><\/template><template data-sn-else><mail-node data-sn-prop="\{ node: \1 \}"><\/mail-node><\/template><\/template>`, 'g');
  let loops = 0;
  for (const f of files) {
    const src = read(f);
    const runs = [...src.matchAll(RUN)].length;
    loops += runs;
    // no other way of reaching mail-node
    expect((src.match(/<mail-node /g) ?? []).length, f).toBe(runs);
  }
  expect(loops).toBeGreaterThan(own.length);
});

test('the generated files are up to date (build-components.mjs --check)', () => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(PKG, 'scripts/build-components.mjs'), '--check'], { cwd: PKG, encoding: 'utf8' });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/files up to date/);
});

test('no whitespace between tags in any component\'s markup', () => {
  for (const f of files) {
    const m = markup(f).replace(/\n$/, '');
    expect(m.match(/>\s+</g), f).toBe(null);
    expect(m, f).not.toMatch(/\n/);
  }
});

test('every attribute and property of the table is bound where its tag renders, the id with its prefix', () => {
  const p = markup(join(DIR, 'internal/mail-p.html'));
  for (const prop of TAGS.p.props) expect(p).toContain(`'${prop}': node.style['${prop}']`.replace(/^'([a-z]+)': node\.style\['\1'\]$/, '$1: node.style.$1'));
  expect(p).toContain("id: node.attrs.id ? 'mail-' + node.attrs.id : null");
  expect(read(join(DIR, 'internal/mail-a.html'))).toContain(`<a target="_blank" rel="noopener noreferrer" data-sn-attr="{ dir: node.attrs.dir, lang: node.attrs.lang, title: node.attrs.title, id: node.attrs.id ? 'mail-' + node.attrs.id : null, href: node.attrs.href, 'data-mail-scheme': node.scheme }"`);
  expect(read(join(DIR, 'internal/mail-img.html'))).toContain('srcset: null');
});
