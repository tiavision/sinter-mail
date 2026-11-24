// The cascade, resolved once at parse time: every element's declarations from its presentational hints,
// the email's <style> rules (by specificity, then order, `!important` after normal ones) and its style
// attribute (above the author's rules, `!important` in it above the author's `!important`), as CSS
// Cascading Level 4 orders them within the author origin. What wins for each kept property is the
// element's style, rendered inline by data-sn-style: there is no stylesheet to evaluate later, so
// `@media` is decided here too (the `media` option), and selectors are matched against the raw tree.
//
// The colour scheme is the one thing an email's styles may change with that the app's page still decides:
// `prefers-color-scheme` is evaluated for both schemes, and an element whose colours differ between them
// gets `light-dark(<light>, <dark>)`, which the browser resolves by the colour scheme the element is shown in
// (the page's, unless the app gives the email another). Anything else a dark rule changes keeps its light
// value: light-dark() takes colours only.
//
// Inheritance is not computed: the tree keeps the document's structure, so an inline style inherits in
// the app as it did in the email.
//
// Pure: no DOM, no Node APIs, only the language's globals, so sinter folds it at build time.
import { attr, type RawElement } from '../raw.js';
import { PROPERTIES } from '../tags.js';
import type { Style } from '../sinter.types.js';
import { hints, legacyColor } from './hints.js';
import { matchMedia, type Media, type Scheme } from './media.js';
import { parseDeclarations, parseStylesheet, rules as parseRules, type Declaration, type Rule } from './parse.js';
import { bucketKey, exhausted, indexTree, matches, parseSelectorList, type Budget, type Complex, type Info } from './selectors.js';
import { expand, joinOverflow, joinTextDecoration, type Assignment, type Longhand } from './values.js';

export { matchMedia } from './media.js';
export { parseStylesheet, parseDeclarations } from './parse.js';
export { expand } from './values.js';
export { tokenize } from './tokenize.js';

export interface ResolveOptions {
  /** the width `@media` is evaluated at: 'wide' (800 px) or 'narrow' (375 px) */
  media: Media;
}

export interface Resolved {
  /** every element's resolved style; elements whose style is empty have no entry */
  styles: Map<RawElement, Style>;
  /**
   * the schemes the email is written for, `light` before `dark`: those its `color-scheme` and
   * `supported-color-schemes` metas name, and the `color-scheme` property of its `<html>` and `<body>`
   */
  colorScheme: Scheme[];
  /** some element's colours change with `prefers-color-scheme`: its style has `light-dark()` */
  dark: boolean;
}

// every tracked longhand by number: an element's values are an array, not a map, since a hostile
// stylesheet can match thousands of rules on every element
const LONGHANDS: Longhand[] = [
  ...(PROPERTIES.filter((p) => p !== 'text-decoration' && p !== 'overflow') as Longhand[]),
  'text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'overflow-x', 'overflow-y',
  'color-scheme',
];
const ID = new Map(LONGHANDS.map((l, i) => [l, i]));

// the colour longhands, by number, with their initial values: what light-dark() is written for, the
// initial value standing in for the scheme whose rules do not set one (`currentcolor` in `color` is the
// inherited colour)
const COLORS = new Map<number, string>([
  ['color', 'currentcolor'], ['background-color', 'transparent'], ['text-decoration-color', 'currentcolor'],
  ['border-top-color', 'currentcolor'], ['border-right-color', 'currentcolor'], ['border-bottom-color', 'currentcolor'], ['border-left-color', 'currentcolor'],
].map(([l, v]) => [ID.get(l as Longhand)!, v]));
const WIDE = new Set(['inherit', 'initial', 'unset']);
const SCHEME = ID.get('color-scheme')!;

// the schemes a rule applies in, as bits
const LIGHT = 1, DARK = 2, BOTH = LIGHT | DARK;

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
  /** unique per entry: a list of matched entries is keyed by these */
  id: number;
  sel: Complex;
  specificity: number;
  order: number;
  normal: Compiled;
  /** null when the rule has no !important declaration */
  important: Compiled | null;
  /** the schemes its `@media` (or its `<style media>`) applies in: LIGHT, DARK or BOTH */
  schemes: number;
}

// the matching work allowed for one resolve (selectors.ts, budget): a 1,800-element newsletter with
// 300 rules takes 0.5 million steps; a hostile stylesheet stops matching here, in a few hundred
// milliseconds on a CI runner (test/css.test.ts, safety)
const MAX_STEPS = 2_000_000;

// the author rules kept for one resolve, every <style> together (one per selector of a list): a real
// email has hundreds; past this a hostile stylesheet's rules are dropped, so compiling them, and going
// through an element's matches, stays bounded
const MAX_RULES = 10_000;

// an element's style is shared with the elements like it when it matches at most this many rules (a real
// email's elements match a handful)
const CACHED = 64;

// `@media` nested deeper than this is dropped rather than walked
const MAX_MEDIA_DEPTH = 16;

/**
 * Every element's resolved style under `options`: the kept properties only, each value re-serialized.
 * Elements whose style is empty have no entry.
 */
export function resolveStyles(root: RawElement, options: ResolveOptions): Map<RawElement, Style> {
  return resolve(root, options).styles;
}

/** the styles of resolveStyles(), and what the email says about colour schemes */
export function resolve(root: RawElement, options: ResolveOptions): Resolved {
  const media = options.media;
  /** the schemes a media query list matches in, within `outer` */
  const schemesOf = (list: Parameters<typeof matchMedia>[0], outer: number) =>
    outer & ((matchMedia(list, media, 'light') ? LIGHT : 0) | (matchMedia(list, media, 'dark') ? DARK : 0));
  const all = indexTree(root);

  // the author rules, from every <style> in document order, bucketed by the kind of their key (bucketKey)
  // so an element looks its id, classes and tag up without building a key string
  const ids = new Map<string, Entry[]>(), classes = new Map<string, Entry[]>(), tags = new Map<string, Entry[]>();
  const universal: Entry[] = [];
  let order = 0, count = 0;
  const addRules = (list: Rule[], depth: number, schemes: number) => {
    for (const r of list) {
      if (r.t === 'at') {
        if (r.name === 'media' && r.block && depth < MAX_MEDIA_DEPTH) {
          const inner = schemesOf(r.prelude, schemes);
          if (inner) addRules(parseRules(r.block.items, false), depth + 1, inner);
        }
        // @import, @font-face, @keyframes, @supports, @layer, @page, @charset and the rest: dropped
        continue;
      }
      const sels = parseSelectorList(r.prelude);
      if (!sels || sels.length === 0) continue;
      const rule = compile(r.declarations);
      // a rule that sets nothing kept is not matched at all
      if (rule.normal.props.length === 0 && rule.important.props.length === 0) continue;
      if (count >= MAX_RULES) return;
      const o = order++;
      for (const sel of sels) {
        const key = bucketKey(sel);
        let b: Entry[] | undefined;
        if (key === '*') b = universal;
        else {
          const kind = key[0] === '#' ? ids : key[0] === '.' ? classes : tags;
          const name = kind === tags ? key : key.slice(1);
          b = kind.get(name);
          if (!b) kind.set(name, (b = []));
        }
        b.push({ id: count++, sel, specificity: sel.specificity, order: o, normal: rule.normal, important: rule.important.props.length ? rule.important : null, schemes });
      }
    }
  };
  // one pass for the <style> elements, the <meta> elements and the body
  let body: Info | null = null;
  const metas: RawElement[] = [];
  for (const e of all) {
    const tag = e.el.tag;
    if (tag === 'meta') metas.push(e.el);
    else if (tag === 'body') { if (body === null && e.parent?.el === root) body = e; }
    else if (tag === 'style' && count < MAX_RULES && isCss(e.el)) {
      const m = attr(e.el, 'media');
      const schemes = m === null ? BOTH : schemesOf(m, BOTH);
      if (!schemes) continue;
      let text = '';
      for (const c of e.el.children) if (c.type === 'text') text += c.value;
      addRules(parseStylesheet(text), 0, schemes);
    }
  }

  const link = body ? attr(body.el, 'link') : null;
  const cx = { link: link !== null ? legacyColor(link) : null };

  // each bucket in cascade order, so an element's matches are merged, not sorted
  for (const kind of [ids, classes, tags]) for (const b of kind.values()) b.sort(byCascade);
  universal.sort(byCascade);

  const out = new Map<RawElement, Style>();
  const values: (string | undefined)[] = new Array(LONGHANDS.length);
  const dark: (string | undefined)[] = new Array(LONGHANDS.length);
  const colorScheme = new Set<string>();
  let anyDark = false;
  for (const el of metas) {
    const name = attr(el, 'name')?.trim().toLowerCase();
    const content = attr(el, 'content');
    if ((name !== 'color-scheme' && name !== 'supported-color-schemes') || content === null) continue;
    const v = expand('color-scheme', content)?.[0]?.[1];
    if (v && !WIDE.has(v)) for (const n of v.split(' ')) colorScheme.add(n);
  }
  const work: Budget = { left: MAX_STEPS };
  const seen: Mask = { m0: 0, m1: 0, m2: 0 };
  // Emails repeat themselves: builders write the same inline style and legacy attributes on every cell of
  // a kind, and those cells match the same rules. So within one resolve: an inline style is parsed once
  // per distinct text, the hints compiled once per distinct list, and an element's style is computed once
  // per distinct (inline style, hints, matched rules) and shared, frozen with the tree, by every element
  // that has the same. Bounded by the input: one entry per distinct string, and per element at most one
  // node per matched rule. Looked up by the inline text, a string the parser already made (a Map hashes a
  // string once), then the hints' key, then the matched entries' ids one by one: no key string to build.
  const inlines = new Map<string, Inline>();
  const hinted = new Map<string, Compiled>();
  for (const e of all) {
    let candidates = NO_ENTRIES;
    if (e.id !== null && ids.size) candidates = take(ids.get(e.id), e, work, candidates);
    const cl = e.classes;
    if (cl.length && classes.size) {
      // a class written twice is matched once
      const many = cl.length > 8 ? new Set<string>() : null;
      for (let i = 0; i < cl.length; i++) {
        const c = cl[i];
        const list = classes.get(c);
        if (!list) continue;
        if (many ? many.has(c) : i > 0 && cl.lastIndexOf(c, i - 1) >= 0) continue;
        many?.add(c);
        candidates = take(list, e, work, candidates);
      }
    }
    if (tags.size) candidates = take(tags.get(e.el.tag), e, work, candidates);
    if (universal.length) candidates = take(universal, e, work, candidates);

    const inline = e.style;
    const hs = hints(e, cx);
    // nothing applies: no style
    if (candidates.length === 0 && inline === null && hs.length === 0) continue;
    let hkey = '';
    for (let i = 0; i < hs.length; i++) hkey += hs[i][0] + ':' + hs[i][1] + ';';
    // an image's style is not shared with other tags': finish writes its negative margin-bottom differently
    const img = e.el.tag === 'img';
    const skey = img ? '\0img' + hkey : hkey;
    let slot = inlines.get(inline ?? '');
    if (!slot) inlines.set(inline ?? '', (slot = { own: undefined, plain: node(), hinted: null }));
    // Not for an element that matches more than CACHED rules (a hostile stylesheet's thousands): its
    // lookup would cost as much as its style, so it is computed as it is
    // <html> and <body> are not shared: their `color-scheme` is read below
    const rootOrBody = e.el === root || e === body;
    let at: Node | null = null;
    if (candidates.length <= CACHED && !rootOrBody) {
      let n: Node | undefined = slot.plain;
      if (skey !== '') {
        const byHints = (slot.hinted ??= new Map());
        n = byHints.get(skey);
        if (!n) byHints.set(skey, (n = node()));
      }
      for (let i = 0; i < candidates.length; i++) {
        const id = candidates[i].id;
        let next: Node | undefined = n.next?.get(id);
        if (!next) (n.next ??= new Map()).set(id, (next = node()));
        n = next;
      }
      at = n;
      const known = n.style;
      if (known !== undefined) {
        if (known) out.set(e.el, known);
        continue;
      }
    }

    if (slot.own === undefined) slot.own = inline !== null ? compile(parseDeclarations(inline)) : null;
    const own = slot.own;
    let h = hinted.get(hkey);
    if (!h) hinted.set(hkey, (h = compiled(hs)));
    cascade(values, LIGHT, own, candidates, h, seen);
    // rules of one scheme only: the dark cascade too, and the colours that differ as light-dark()
    let split = false;
    for (let i = 0; i < candidates.length; i++) if (candidates[i].schemes !== BOTH) { split = true; break; }
    if (split) {
      cascade(dark, DARK, own, candidates, h, seen);
      for (const [i, initial] of COLORS) {
        const l = values[i], d = dark[i];
        if (l === d || (l !== undefined && WIDE.has(l)) || (d !== undefined && WIDE.has(d))) continue;
        values[i] = `light-dark(${l ?? initial}, ${d ?? initial})`;
        anyDark = true;
      }
    }
    if (rootOrBody) {
      const v = values[SCHEME];
      if (v !== undefined && !WIDE.has(v)) for (const n of v.split(' ')) colorScheme.add(n);
    }
    const style = finish(values, img);
    if (at) at.style = style;
    if (style) out.set(e.el, style);
  }
  const schemes = (['light', 'dark'] as const).filter((s) => colorScheme.has(s));
  return { styles: out, colorScheme: schemes, dark: anyDark };
}

/** an inline style's text: its declarations, compiled when first needed, and the styles computed with it */
interface Inline {
  own: StyleRule | null | undefined;
  /** the styles of elements with no hints, by their matched entries */
  plain: Node;
  /** the others' (and images'), by their hints' key, then their matched entries */
  hinted: Map<string, Node> | null;
}

/** a style computed for one list of matched entries (the path to it), and the longer lists that start with it */
interface Node {
  style: Style | null | undefined;
  next: Map<number, Node> | null;
}
const node = (): Node => ({ style: undefined, next: null });

/** no entries: shared, never written to */
const NO_ENTRIES: Entry[] = [];

const byCascade = (a: Entry, b: Entry) => a.specificity - b.specificity || a.order - b.order;

/** `into` with the entries of `list` that match `e`, in cascade order */
function take(list: Entry[] | undefined, e: Info, work: Budget, into: Entry[]): Entry[] {
  if (!list || exhausted(work)) return into;
  let m: Entry[] | null = null;
  for (let i = 0; i < list.length; i++) if (matches(list[i].sel, e, work)) (m ??= []).push(list[i]);
  return m === null ? into : into.length ? merge(into, m) : m;
}

/** the longhands set so far in one cascade, as Compiled masks them */
interface Mask {
  m0: number;
  m1: number;
  m2: number;
}

/**
 * From the highest precedence down, each longhand taken from the first that sets it: inline !important,
 * author !important (the last in cascade order first), inline, author, hints; the author's rules those of
 * `scheme` only.
 */
function cascade(into: (string | undefined)[], scheme: number, own: StyleRule | null, candidates: Entry[], h: Compiled, seen: Mask): void {
  into.fill(undefined);
  seen.m0 = seen.m1 = seen.m2 = 0;
  if (own) apply(into, own.important, seen);
  for (let i = candidates.length - 1; i >= 0; i--) { const c = candidates[i]; if (c.important && c.schemes & scheme) apply(into, c.important, seen); }
  if (own) apply(into, own.normal, seen);
  for (let i = candidates.length - 1; i >= 0; i--) { const c = candidates[i]; if (c.schemes & scheme) apply(into, c.normal, seen); }
  apply(into, h, seen);
}

/** `c`'s longhands that nothing above it set; a rule whose longhands are all set is skipped by its masks */
function apply(into: (string | undefined)[], c: Compiled, seen: Mask): void {
  if (!((c.m0 & ~seen.m0) | (c.m1 & ~seen.m1) | (c.m2 & ~seen.m2))) return;
  for (let i = 0; i < c.props.length; i++) if (into[c.props[i]] === undefined) into[c.props[i]] = c.values[i];
  seen.m0 |= c.m0; seen.m1 |= c.m1; seen.m2 |= c.m2;
}

/** two lists in cascade order as one */
function merge(a: Entry[], b: Entry[]): Entry[] {
  const out: Entry[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) out.push(byCascade(a[i], b[j]) <= 0 ? a[i++] : b[j++]);
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

function compiled(list: readonly Assignment[]): Compiled {
  // from the last assignment back, each longhand's first seen (its mask bit not yet set) is the one that wins;
  // reversed, they are in the order of the winning assignments
  const props: number[] = [], values: string[] = [];
  const mask = [0, 0, 0];
  for (let i = list.length - 1; i >= 0; i--) {
    const id = ID.get(list[i][0])!;
    const w = Math.floor(id / 30), bit = 1 << id % 30;
    if (mask[w] & bit) continue;
    mask[w] |= bit;
    props.push(id);
    values.push(list[i][1]);
  }
  props.reverse();
  values.reverse();
  return { props, values, m0: mask[0], m1: mask[1], m2: mask[2] };
}

// for each kept property, in PROPERTIES order, its longhand's number; -1 for the two joined from longhands
const TEXT_DECORATION = -1, OVERFLOW = -2;
const KEPT = PROPERTIES.map((p) => (p === 'text-decoration' ? TEXT_DECORATION : p === 'overflow' ? OVERFLOW : ID.get(p as Longhand)!));
const [TD_LINE, TD_STYLE, TD_COLOR, OVERFLOW_X, OVERFLOW_Y] = (['text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'overflow-x', 'overflow-y'] as const).map((l) => ID.get(l)!);
const [MARGIN_BOTTOM, VERTICAL_ALIGN, DISPLAY, FLOAT] = (['margin-bottom', 'vertical-align', 'display', 'float'] as const).map((l) => ID.get(l)!);

/**
 * The vertical-align that puts an image where its negative margin-bottom does, or null. An inline image sits
 * on the baseline by its margin box's bottom edge, so `margin-bottom: -6px` lowers it 6 px, as
 * `vertical-align: -6px` does. The margin would let the image hang out of the email's box (and a float's or
 * a block's margin would move it out); vertical-align cannot, as the line box grows around what it lowers.
 * The bound is values.ts's (about one em, as vertical-align's own). Only for an image inline (by its
 * default or its style) on the baseline, not floated; a box whose display the app changes ignores
 * vertical-align and keeps 0. Not for an inline-block with text in it: its baseline is its last line's, and a
 * margin does not move it.
 */
function lowered(values: (string | undefined)[], img: boolean): string | null {
  const mb = values[MARGIN_BOTTOM];
  if (!img || mb === undefined || mb[0] !== '-') return null;
  const d = values[DISPLAY], va = values[VERTICAL_ALIGN], f = values[FLOAT];
  if (d !== undefined && d !== 'inline' && d !== 'inline-block') return null;
  if (va !== undefined && va !== 'baseline') return null;
  if (f !== undefined && f !== 'none') return null;
  return mb;
}

/** the tracked longhands as the element's style: the kept properties, in PROPERTIES order */
function finish(values: (string | undefined)[], img: boolean): Style | null {
  const style: Style = {};
  let any = false;
  const shift = lowered(values, img);
  for (let k = 0; k < KEPT.length; k++) {
    const id = KEPT[k];
    let v: string | null | undefined;
    if (id === TEXT_DECORATION) v = joinTextDecoration(values[TD_LINE], values[TD_STYLE], values[TD_COLOR]);
    else if (id === OVERFLOW) v = joinOverflow(values[OVERFLOW_X], values[OVERFLOW_Y]);
    // a negative margin is never written (values.ts keeps a small one in margin-bottom for lowered)
    else if (id === MARGIN_BOTTOM && values[id]?.[0] === '-') v = '0';
    else if (id === VERTICAL_ALIGN && shift !== null) v = shift;
    else v = values[id];
    if (v != null && safe(v)) { style[PROPERTIES[k]] = v; any = true; }
  }
  return any ? style : null;
}

/** the runtime's own check, as a last gate: what it would refuse is never written */
const safe = (v: string) => !/\\|url\(|image\(|image-set\(/i.test(v);
