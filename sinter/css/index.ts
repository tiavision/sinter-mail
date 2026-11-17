// The cascade, resolved once at parse time: every element's declarations from its presentational hints,
// the email's <style> rules (by specificity, then order, `!important` after normal ones) and its style
// attribute (above the author's rules, `!important` in it above the author's `!important`), as CSS
// Cascading Level 4 orders them within the author origin. What wins for each kept property is the
// element's style, rendered inline by data-sn-style: there is no stylesheet to evaluate later, so
// `@media` is decided here too (the `media` option), and selectors are matched against the raw tree.
//
// Inheritance is not computed: the tree keeps the document's structure, so an inline style inherits in
// the app as it did in the email.
//
// Pure: no DOM, no Node APIs, only the language's globals, so sinter folds it at build time.
import { attr, type RawElement } from '../raw.js';
import { PROPERTIES } from '../tags.js';
import type { Property, Style } from '../sinter.types.js';
import { hints, legacyColor } from './hints.js';
import { matchMedia, type Media } from './media.js';
import { parseDeclarations, parseStylesheet, rules as parseRules, type Declaration, type Rule } from './parse.js';
import { bucketKey, budget, exhausted, indexTree, matches, parseSelectorList, type Complex } from './selectors.js';
import { expand, joinOverflow, joinTextDecoration, type Assignment, type Longhand } from './values.js';

export { matchMedia } from './media.js';
export { parseStylesheet, parseDeclarations } from './parse.js';
export { expand } from './values.js';
export { tokenize } from './tokenize.js';

export interface ResolveOptions {
  /** the width `@media` is evaluated at: 'wide' (800 px) or 'narrow' (375 px) */
  media: Media;
}

// every tracked longhand by number: an element's values are an array, not a map, since a hostile
// stylesheet can match thousands of rules on every element
const LONGHANDS: Longhand[] = [
  ...(PROPERTIES.filter((p) => p !== 'text-decoration' && p !== 'overflow') as Longhand[]),
  'text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'overflow-x', 'overflow-y',
];
const ID = new Map(LONGHANDS.map((l, i) => [l, i]));

/**
 * Assignments as parallel arrays of longhand numbers and values, the last one per longhand only, and
 * which longhands they set as a bit mask in three 30-bit words (small integers), so a rule whose
 * longhands a higher one already set is skipped with a few integer operations.
 */
interface Compiled {
  props: number[];
  values: string[];
  m0: number;
  m1: number;
  m2: number;
}
if (LONGHANDS.length > 90) throw new Error('sinter/css: more longhands than the masks hold');

interface StyleRule {
  normal: Compiled;
  important: Compiled;
}

interface Entry {
  sel: Complex;
  specificity: number;
  order: number;
  normal: Compiled;
  /** null when the rule has no !important declaration */
  important: Compiled | null;
}

// the matching work allowed for one resolve (selectors.ts, budget): a 1,800-element newsletter with
// 300 rules takes 0.5 million steps; a hostile stylesheet stops matching here, within about a second
const MAX_STEPS = 8_000_000;

// `@media` nested deeper than this is dropped rather than walked
const MAX_MEDIA_DEPTH = 16;

/**
 * Every element's resolved style under `options`: the kept properties only, each value re-serialized.
 * Elements whose style is empty have no entry.
 */
export function resolveStyles(root: RawElement, options: ResolveOptions): Map<RawElement, Style> {
  const media = options.media;
  const all = indexTree(root);

  // the author rules, from every <style> in document order
  const buckets = new Map<string, Entry[]>();
  let order = 0;
  const addRules = (list: Rule[], depth: number) => {
    for (const r of list) {
      if (r.t === 'at') {
        if (r.name === 'media' && r.block && depth < MAX_MEDIA_DEPTH && matchMedia(r.prelude, media)) addRules(parseRules(r.block.items, false), depth + 1);
        // @import, @font-face, @keyframes, @supports, @layer, @page, @charset and the rest: dropped
        continue;
      }
      const sels = parseSelectorList(r.prelude);
      if (!sels || sels.length === 0) continue;
      const rule = compile(r.declarations);
      // a rule that sets nothing kept is not matched at all
      if (rule.normal.props.length === 0 && rule.important.props.length === 0) continue;
      const o = order++;
      for (const sel of sels) {
        const key = bucketKey(sel);
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = []));
        b.push({ sel, specificity: sel.specificity, order: o, normal: rule.normal, important: rule.important.props.length ? rule.important : null });
      }
    }
  };
  for (const e of all) {
    if (e.el.tag !== 'style' || !isCss(e.el)) continue;
    const m = attr(e.el, 'media');
    if (m !== null && !matchMedia(m, media)) continue;
    let text = '';
    for (const c of e.el.children) if (c.type === 'text') text += c.value;
    addRules(parseStylesheet(text), 0);
  }

  const body = all.find((e) => e.el.tag === 'body' && e.parent?.el === root) ?? null;
  const link = body ? attr(body.el, 'link') : null;
  const cx = { link: link !== null ? legacyColor(link) : null };

  // each bucket in cascade order, so an element's matches are merged, not sorted
  const byCascade = (a: Entry, b: Entry) => a.specificity - b.specificity || a.order - b.order;
  for (const b of buckets.values()) b.sort(byCascade);

  const out = new Map<RawElement, Style>();
  const universal = buckets.get('*');
  const values: (string | undefined)[] = new Array(LONGHANDS.length);
  budget(MAX_STEPS);
  try {
    for (const e of all) {
      let candidates: Entry[] = [];
      const take = (list: Entry[] | undefined) => {
        if (!list || exhausted()) return;
        const m: Entry[] = [];
        for (const x of list) if (matches(x.sel, e)) m.push(x);
        if (m.length) candidates = candidates.length ? merge(candidates, m, byCascade) : m;
      };
      if (e.id !== null) take(buckets.get('#' + e.id));
      const seen = new Set<string>();
      for (const c of e.classes) if (!seen.has(c)) { seen.add(c); take(buckets.get('.' + c)); }
      take(buckets.get(e.el.tag));
      take(universal);

      // from the highest precedence down, each longhand taken from the first that sets it: inline
      // !important, author !important (the last in cascade order first), inline, author, hints
      values.fill(undefined);
      let s0 = 0, s1 = 0, s2 = 0;
      const apply = (c: Compiled) => {
        if (!((c.m0 & ~s0) | (c.m1 & ~s1) | (c.m2 & ~s2))) return;
        for (let i = 0; i < c.props.length; i++) if (values[c.props[i]] === undefined) values[c.props[i]] = c.values[i];
        s0 |= c.m0; s1 |= c.m1; s2 |= c.m2;
      };
      const inline = attr(e.el, 'style');
      const own = inline !== null ? compile(parseDeclarations(inline)) : null;
      if (own) apply(own.important);
      for (let i = candidates.length - 1; i >= 0; i--) { const imp = candidates[i].important; if (imp) apply(imp); }
      if (own) apply(own.normal);
      for (let i = candidates.length - 1; i >= 0; i--) apply(candidates[i].normal);
      apply(compiled(hints(e, cx)));
      const style = finish(values);
      if (style) out.set(e.el, style);
    }
  } finally {
    budget(Infinity);
  }
  return out;
}

/** two lists in cascade order as one */
function merge(a: Entry[], b: Entry[], cmp: (x: Entry, y: Entry) => number): Entry[] {
  const out: Entry[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) out.push(cmp(a[i], b[j]) <= 0 ? a[i++] : b[j++]);
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

const isCss = (el: RawElement) => {
  const t = attr(el, 'type');
  if (t === null) return true;
  const v = t.trim().toLowerCase();
  return v === '' || v === 'text/css';
};

/** a rule's declarations as longhand assignments, normal and important apart, in declaration order */
function compile(decls: Declaration[]): StyleRule {
  const normal: Assignment[] = [];
  const important: Assignment[] = [];
  for (const d of decls) {
    const a = expand(d.name, d.value);
    if (a) (d.important ? important : normal).push(...a);
  }
  return { normal: compiled(normal), important: compiled(important) };
}

function compiled(list: Assignment[]): Compiled {
  const last = new Map<number, string>();
  for (const [p, v] of list) {
    const id = ID.get(p)!;
    // re-inserted, so the map's order stays the order of the winning assignments
    last.delete(id);
    last.set(id, v);
  }
  const mask = [0, 0, 0];
  for (const id of last.keys()) mask[Math.floor(id / 30)] |= 1 << id % 30;
  return { props: [...last.keys()], values: [...last.values()], m0: mask[0], m1: mask[1], m2: mask[2] };
}

const at = (values: (string | undefined)[], l: Longhand) => values[ID.get(l)!];

/** the tracked longhands as the element's style: the kept properties, in PROPERTIES order */
function finish(values: (string | undefined)[]): Style | null {
  const style: Style = {};
  let any = false;
  for (const p of PROPERTIES as readonly Property[]) {
    let v: string | null | undefined;
    if (p === 'text-decoration') v = joinTextDecoration(at(values, 'text-decoration-line'), at(values, 'text-decoration-style'), at(values, 'text-decoration-color'));
    else if (p === 'overflow') v = joinOverflow(at(values, 'overflow-x'), at(values, 'overflow-y'));
    else v = at(values, p);
    if (v != null && safe(v)) { style[p] = v; any = true; }
  }
  return any ? style : null;
}

/** the runtime's own check, as a last gate: what it would refuse is never written */
const safe = (v: string) => !/\\|url\(|image\(|image-set\(/i.test(v);
