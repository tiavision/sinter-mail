// Writes sinter/components/internal/ from the tag table (sinter/tags.ts): the dispatch (mail-node.html),
// one component per tag that renders on its own, and the table's component, which renders a table's whole
// structure (the HTML parser would move a component's tag written inside a <table> out of it).
//
//   node --experimental-strip-types scripts/build-components.mjs           writes the files
//   node --experimental-strip-types scripts/build-components.mjs --check   fails when they differ
//
// Every file is markup without whitespace between tags: whitespace is text, and would show in tables and
// phrasing content, once per row of a loop. The files are committed; test/components.test.ts runs --check.
//
// What the components bind, per element:
// - `data-sn-attr`: the tag's attributes (sinter/tags.ts, attrsOf: the global ones included), literal keys.
//   The id is the exception: parse.ts keeps one only when an in-email `#fragment` link points at it, and
//   writes that link already prefixed, so the element renders `id: node.attrs.id ? 'mail-' + node.attrs.id :
//   null`: every id it can set starts with the literal, which sinter's SN503 accepts.
// - `data-sn-style`: the properties its tag binds, literal keys; a property the tree leaves out is
//   `undefined`, and nothing is written.
// - `data-sn-class`: the parts (`mail-quote`, `mail-signature`), on the tags they occur on (PARTS).
// - its children, unless void: text runs first, every element through mail-node.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAGS, attrsOf } from '../sinter/tags.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'sinter/components/internal');

/** the tags whose elements carry a `part`: mail.plain's quotes and signature (quoted replies in HTML later) */
const PARTS = new Set(['blockquote', 'div']);
/** HTML's void elements: no end tag, no children, whatever the table says (a template after one is its sibling) */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const isVoid = (tag) => !!TAGS[tag].void || VOID.has(tag);
/** an in-table element outside a table: its content, as the browser keeps it (parse.ts never writes one there) */
const ORPHAN = 'mail-orphan';

const IDENT = /^[a-z][a-z0-9]*$/;
const key = (k) => (IDENT.test(k) ? k : `'${k}'`);
const read = (obj, k) => (IDENT.test(k) ? `${obj}.${k}` : `${obj}['${k}']`);

/** `data-sn-attr` for the element `v` of `tag`; `id`: with the prefixed id */
function attrs(v, tag, id, extra = []) {
  const entries = attrsOf(tag).flatMap((a) => a === 'id' ? (id ? [`id: ${v}.attrs.id ? 'mail-' + ${v}.attrs.id : null`] : []) : [`${key(a)}: ${read(`${v}.attrs`, a)}`]);
  const all = [...entries, ...extra];
  return all.length ? ` data-sn-attr="{ ${all.join(', ')} }"` : '';
}
/** `data-sn-style` for the element `v` of `tag`: the properties its tag binds */
function style(v, tag) {
  const props = TAGS[tag].props;
  return props.length ? ` data-sn-style="{ ${props.map((p) => `${key(p)}: ${read(`${v}.style`, p)}`).join(', ')} }"` : '';
}
/** `data-sn-class` for the parts, on the tags where they occur */
const parts = (v, tag) => (PARTS.has(tag) ? ` data-sn-class="{ 'mail-quote': ${v}.part === 'quote', 'mail-signature': ${v}.part === 'signature' }"` : '');
/** the start tag of the element `v` of `tag`, with its bindings */
const open = (v, tag, { id = false, literal = '', extra = [] } = {}) => `<${tag}${literal}${attrs(v, tag, id, extra)}${style(v, tag)}${parts(v, tag)}>`;
/**
 * An element is rendered only when it is shown: one the email hides (`display: none` in its resolved style, at the
 * width the tree was parsed for) is not in the page at all, so its images never load. A tree parsed for another
 * width (mail.parse's `media`) is another tree, and what it shows renders then.
 */
const shown = (v) => `${v}.style.display !== 'none'`;
/** the loop over the children of `v`: text runs first, every shown element through mail-node */
const children = (v, c) => `<template data-sn-for="${c} in ${v}.children"><template data-sn-if="${c}.type === 'text'"><template data-sn-text="${c}.value"></template></template><template data-sn-else><template data-sn-if="${shown(c)}"><mail-node data-sn-with="{ node: ${c} }"></mail-node></template></template></template>`;
/** an if chain: the first branch whose condition holds; `last`, if given, the final else */
function chain(branches, last = '') {
  return branches.reduceRight((rest, [cond, then]) => `<template data-sn-if="${cond}">${then}</template>${rest ? `<template data-sn-else>${rest}</template>` : ''}`, last);
}
/** the element `v` of `tag` with `inner` inside (unless void); with its id when `ids` */
function element(v, tag, inner, { ids = attrsOf(tag).includes('id'), literal = '', extra = [] } = {}) {
  return `${open(v, tag, { id: ids, literal, extra })}${isVoid(tag) ? '' : `${inner}</${tag}>`}`;
}

const HEAD = (what) => `<!--\n  Generated by scripts/build-components.mjs from sinter/tags.ts: do not edit.\n  ${what}\n-->\n`;
const component = (what, root) => `${HEAD(what)}<template data-sn-props="{ node: Element }">${root}</template>\n`;

/** a table and its whole structure, chosen by chains over each child's tag */
function table() {
  const cell = (d) => chain([
    [`${d}.type === 'element' && ${shown(d)} && ${d}.tag === 'th'`, element(d, 'th', children(d, 'n'))],
    [`${d}.type === 'element' && ${shown(d)}`, element(d, 'td', children(d, 'n'))],
  ]);
  const rows = (s) => `<template data-sn-for="r in ${s}.children"><template data-sn-if="r.type === 'element' && ${shown('r')}">${element('r', 'tr', `<template data-sn-for="d in r.children">${cell('d')}</template>`)}</template></template>`;
  const section = (tag) => element('s', tag, rows('s'));
  const cols = `<template data-sn-for="k in s.children"><template data-sn-if="k.type === 'element'">${element('k', 'col', '')}</template></template>`;
  const content = chain([
    [`s.type === 'element' && ${shown('s')} && s.tag === 'caption'`, element('s', 'caption', children('s', 'n'))],
    [`s.type === 'element' && s.tag === 'colgroup'`, element('s', 'colgroup', cols)],
    [`s.type === 'element' && ${shown('s')} && s.tag === 'thead'`, section('thead')],
    [`s.type === 'element' && ${shown('s')} && s.tag === 'tfoot'`, section('tfoot')],
    [`s.type === 'element' && ${shown('s')}`, section('tbody')],
  ]);
  return element('node', 'table', `<template data-sn-for="s in node.children">${content}</template>`);
}

const files = {};
const tags = Object.keys(TAGS).sort();
const own = tags.filter((t) => !TAGS[t].inTable);

files['mail-node.html'] = component(
  `One element, by its tag: the only place elements are dispatched. A table's parts render inside mail-table; one outside a table (which parse.ts never writes) renders its content, through ${ORPHAN}.`,
  `<sn-component use="{ ${tags.map((t) => `${key(t)}: '${TAGS[t].inTable ? ORPHAN : `mail-${t}`}'`).join(', ')} }[node.tag]" data-sn-with="{ node }"></sn-component>`,
);
files[`${ORPHAN}.html`] = component(
  'A table\'s part outside a table, which parse.ts never writes: its content in a <span>, as the browser drops the tag and keeps what it holds.',
  `<span>${children('node', 'c')}</span>`,
);
for (const tag of own) {
  const name = `mail-${tag}.html`;
  if (tag === 'a') {
    files[name] = component(
      'A link: its root is the `link` slot; the default opens the address in a new tab, without the opener or the referrer.',
      `<slot name="link" data-sn-with="{ node }">${element('node', 'a', children('node', 'c'), { literal: ' target="_blank" rel="noopener noreferrer"' })}</slot>`,
    );
  } else if (tag === 'img') {
    files[name] = component(
      'An image: its root is the `image` slot. A blocked image has no src, and its box keeps width, height and alt. `srcset: null` keeps it out of the app\'s resizing service.',
      `<slot name="image" data-sn-with="{ node }">${element('node', 'img', '', { extra: ['srcset: null'] })}</slot>`,
    );
  } else if (tag === 'table') {
    files[name] = component(
      'A table and its whole structure: a component\'s tag inside a <table> would be moved out of it by the HTML parser, so caption, colgroup, col, the sections, rows and cells are literal here, chosen by their tag. Cell content goes through mail-node.',
      table(),
    );
  } else {
    files[name] = component(`<${tag}>.`, element('node', tag, children('node', 'c')));
  }
}

// ── write or check ────────────────────────────────────────────────────────────────────────────────────
const check = process.argv.includes('--check');
// written by hand, not from the table: <mail-body>'s template rendering and its script renderer (mail-view.ts)
const HAND = new Set(['mail-tree.html', 'mail-view.html']);
const present = existsSync(OUT) ? readdirSync(OUT).filter((f) => f.endsWith('.html') && !HAND.has(f)) : [];
const stale = present.filter((f) => !(f in files));
const differ = Object.entries(files).filter(([f, s]) => !existsSync(join(OUT, f)) || readFileSync(join(OUT, f), 'utf8') !== s).map(([f]) => f);
if (check) {
  if (differ.length || stale.length) {
    console.error(`sinter/components/internal/ is out of date (run npm run build:components):${[...differ.map((f) => `\n  differs: ${f}`), ...stale.map((f) => `\n  not generated: ${f}`)].join('')}`);
    process.exit(1);
  }
  console.log(`sinter/components/internal/: ${Object.keys(files).length} files up to date`);
} else {
  mkdirSync(OUT, { recursive: true });
  for (const f of stale) rmSync(join(OUT, f));
  for (const f of differ) writeFileSync(join(OUT, f), files[f]);
  console.log(`sinter/components/internal/: ${Object.keys(files).length} files, ${differ.length} written, ${stale.length} removed`);
}
