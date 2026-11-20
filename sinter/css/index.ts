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
// value: light-dark() takes colours only. But an element that one scheme's rules hide (`display: none`) is
// shown in the other scheme only (`only`: a dark logo beside the light one), it and everything inside it
// with that scheme's styles whole (the hacks that hide it from Outlook, `max-height: 0`, undone with it).
//
// Inheritance is not computed: the tree keeps the document's structure, so an inline style inherits in
// the app as it did in the email.
//
// Pure: no DOM, no Node APIs, only the language's globals, so sinter folds it at build time.
import { attr, type RawElement } from '../raw.js';
import { PROPERTIES } from '../tags.js';
import type { Property, Style } from '../sinter.types.js';
import { hints, legacyColor } from './hints.js';
import { matchMedia, type Media, type Scheme } from './media.js';
import { parseDeclarations, parseStylesheet, rules as parseRules, type Declaration, type Rule } from './parse.js';
import { bucketKey, exhausted, indexTree, matches, parseSelectorList, type Budget, type Complex } from './selectors.js';
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
  /**
   * The elements shown in one scheme only: one scheme's rules hide them (`display: none`), the other's
   * show them. Their styles, and those of the elements inside them, are that scheme's.
   */
  only: Map<RawElement, Scheme>;
  /** the email's styles change with `prefers-color-scheme`: a colour (`light-dark()`), or an element in `only` */
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
const DISPLAY = ID.get('display')!;

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

  // the author rules, from every <style> in document order
  const buckets = new Map<string, Entry[]>();
  let order = 0, ids = 0;
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
      if (ids >= MAX_RULES) return;
      const o = order++;
      for (const sel of sels) {
        const key = bucketKey(sel);
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = []));
        b.push({ id: ids++, sel, specificity: sel.specificity, order: o, normal: rule.normal, important: rule.important.props.length ? rule.important : null, schemes });
      }
    }
  };
  for (const e of all) {
    if (e.el.tag !== 'style' || !isCss(e.el)) continue;
    const m = attr(e.el, 'media');
    const schemes = m === null ? BOTH : schemesOf(m, BOTH);
    if (!schemes) continue;
    let text = '';
    for (const c of e.el.children) if (c.type === 'text') text += c.value;
    if (ids >= MAX_RULES) break;
    addRules(parseStylesheet(text), 0, schemes);
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
  const dark: (string | undefined)[] = new Array(LONGHANDS.length);
  const colorScheme = new Set<string>();
  let anyDark = false;
  for (const e of all) {
    if (e.el.tag !== 'meta') continue;
    const name = attr(e.el, 'name')?.trim().toLowerCase();
    const content = attr(e.el, 'content');
    if ((name !== 'color-scheme' && name !== 'supported-color-schemes') || content === null) continue;
    const v = expand('color-scheme', content)?.[0]?.[1];
    if (v && !WIDE.has(v)) for (const n of v.split(' ')) colorScheme.add(n);
  }
  const work: Budget = { left: MAX_STEPS };
  // Emails repeat themselves: builders write the same inline style and legacy attributes on every cell of
  // a kind, and those cells match the same rules. So within one resolve: an inline style is parsed once
  // per distinct text, the hints compiled once per distinct list, and an element's style is computed once
  // per distinct (matched rules, inline style, hints) and shared, frozen with the tree, by every element
  // that has the same. Bounded by the input: one entry per distinct string.
  const inlines = new Map<string, StyleRule>();
  const hinted = new Map<string, Compiled>();
  const styles = new Map<string, { style: Style | null; only: Scheme | null }>();
  // the scheme an element is shown in only, by its own rules or an ancestor's (document order: a parent
  // comes before its children); the ones whose own rules decide it are the result's `only`
  const within = new Map<RawElement, Scheme>();
  const only = new Map<RawElement, Scheme>();
  {
    for (const e of all) {
      const inside = e.parent ? within.get(e.parent.el) ?? null : null;
      let candidates: Entry[] = [];
      const take = (list: Entry[] | undefined) => {
        if (!list || exhausted(work)) return;
        const m: Entry[] = [];
        for (const x of list) if (matches(x.sel, e, work)) m.push(x);
        if (m.length) candidates = candidates.length ? merge(candidates, m, byCascade) : m;
      };
      if (e.id !== null) take(buckets.get('#' + e.id));
      const seen = new Set<string>();
      for (const c of e.classes) if (!seen.has(c)) { seen.add(c); take(buckets.get('.' + c)); }
      take(buckets.get(e.el.tag));
      take(universal);

      const inline = attr(e.el, 'style');
      const hs = hints(e, cx);
      let hkey = '';
      for (const [p, v] of hs) hkey += p + ':' + v + ';';
      // the hints (no `|` in them), the matched entries' ids, then the inline text: unambiguous. Not for an
      // element that matches more than CACHED rules (a hostile stylesheet's thousands): its key would cost
      // as much as its style, so it is computed as it is
      // <html> and <body> are not shared: their `color-scheme` is read below
      const rootOrBody = e.el === root || e === body;
      let key: string | null = null;
      if (candidates.length <= CACHED && !rootOrBody) {
        key = (inside ?? '') + '|' + hkey + '|';
        for (const c of candidates) key += c.id + ',';
        key += '|' + (inline ?? '');
        const known = styles.get(key);
        if (known !== undefined) {
          if (known.style) out.set(e.el, known.style);
          const shown = inside ?? known.only;
          if (shown) within.set(e.el, shown);
          if (known.only) only.set(e.el, known.only);
          continue;
        }
      }

      let own: StyleRule | null = null;
      if (inline !== null) {
        own = inlines.get(inline) ?? null;
        if (!own) inlines.set(inline, (own = compile(parseDeclarations(inline))));
      }
      let h = hinted.get(hkey);
      if (!h) hinted.set(hkey, (h = compiled(hs)));
      // from the highest precedence down, each longhand taken from the first that sets it: inline
      // !important, author !important (the last in cascade order first), inline, author, hints; the
      // author's rules those of `scheme` only
      const cascade = (into: (string | undefined)[], scheme: number) => {
        into.fill(undefined);
        let s0 = 0, s1 = 0, s2 = 0;
        const apply = (c: Compiled) => {
          if (!((c.m0 & ~s0) | (c.m1 & ~s1) | (c.m2 & ~s2))) return;
          for (let i = 0; i < c.props.length; i++) if (into[c.props[i]] === undefined) into[c.props[i]] = c.values[i];
          s0 |= c.m0; s1 |= c.m1; s2 |= c.m2;
        };
        if (own) apply(own.important);
        for (let i = candidates.length - 1; i >= 0; i--) { const c = candidates[i]; if (c.important && c.schemes & scheme) apply(c.important); }
        if (own) apply(own.normal);
        for (let i = candidates.length - 1; i >= 0; i--) { const c = candidates[i]; if (c.schemes & scheme) apply(c.normal); }
        apply(h);
      };
      cascade(values, LIGHT);
      // rules of one scheme only: the dark cascade too. Inside an element shown in one scheme, that scheme's
      // styles; an element that one scheme hides and the other shows, the other's, and it is shown in that
      // one only; any other, the colours that differ as light-dark()
      let shownIn: Scheme | null = null;
      if (candidates.some((c) => c.schemes !== BOTH)) {
        cascade(dark, DARK);
        if (!inside && (values[DISPLAY] === 'none') !== (dark[DISPLAY] === 'none')) shownIn = values[DISPLAY] === 'none' ? 'dark' : 'light';
        const scheme = inside ?? shownIn;
        if (scheme === 'dark') for (let i = 0; i < values.length; i++) values[i] = dark[i];
        else if (scheme === null) {
          for (const [i, initial] of COLORS) {
            const l = values[i], d = dark[i];
            if (l === d || (l !== undefined && WIDE.has(l)) || (d !== undefined && WIDE.has(d))) continue;
            values[i] = `light-dark(${l ?? initial}, ${d ?? initial})`;
            anyDark = true;
          }
        }
        if (shownIn) anyDark = true;
      }
      const shown = inside ?? shownIn;
      if (shown) within.set(e.el, shown);
      if (shownIn) only.set(e.el, shownIn);
      if (rootOrBody) {
        const v = values[SCHEME];
        if (v !== undefined && !WIDE.has(v)) for (const n of v.split(' ')) colorScheme.add(n);
      }
      const style = finish(values);
      if (key !== null) styles.set(key, { style, only: shownIn });
      if (style) out.set(e.el, style);
    }
  }
  const schemes = (['light', 'dark'] as const).filter((s) => colorScheme.has(s));
  return { styles: out, colorScheme: schemes, only, dark: anyDark };
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
