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
import { bucketKey, indexTree, matches, parseSelectorList, type Complex, type Info } from './selectors.js';
import { expand, joinOverflow, joinTextDecoration, type Assignment, type Longhand } from './values.js';

export { matchMedia } from './media.js';
export { parseStylesheet, parseDeclarations } from './parse.js';
export { expand } from './values.js';
export { tokenize } from './tokenize.js';

export interface ResolveOptions {
  /** the width `@media` is evaluated at: 'wide' (800 px) or 'narrow' (375 px) */
  media: Media;
}

interface StyleRule {
  normal: Assignment[];
  important: Assignment[];
}

interface Entry {
  sel: Complex;
  specificity: number;
  order: number;
  rule: StyleRule;
}

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
      if (rule.normal.length === 0 && rule.important.length === 0) continue;
      const o = order++;
      for (const sel of sels) {
        const key = bucketKey(sel);
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = []));
        b.push({ sel, specificity: sel.specificity, order: o, rule });
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

  const out = new Map<RawElement, Style>();
  const universal = buckets.get('*') ?? [];
  for (const e of all) {
    const candidates: Entry[] = [];
    const take = (list: Entry[] | undefined) => { if (list) for (const x of list) if (matches(x.sel, e)) candidates.push(x); };
    if (e.id !== null) take(buckets.get('#' + e.id));
    const seen = new Set<string>();
    for (const c of e.classes) if (!seen.has(c)) { seen.add(c); take(buckets.get('.' + c)); }
    take(buckets.get(e.el.tag));
    take(universal);
    candidates.sort((a, b) => a.specificity - b.specificity || a.order - b.order);

    const values = new Map<Longhand, string>();
    const apply = (list: Assignment[]) => { for (const [p, v] of list) values.set(p, v); };
    apply(hints(e, cx));
    const inline = attr(e.el, 'style');
    const own = inline !== null ? compile(parseDeclarations(inline)) : null;
    for (const c of candidates) apply(c.rule.normal);
    if (own) apply(own.normal);
    for (const c of candidates) apply(c.rule.important);
    if (own) apply(own.important);
    const style = finish(values);
    if (style) out.set(e.el, style);
  }
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
  return { normal, important };
}

/** the tracked longhands as the element's style: the kept properties, in PROPERTIES order */
function finish(values: Map<Longhand, string>): Style | null {
  if (values.size === 0) return null;
  const style: Style = {};
  let any = false;
  for (const p of PROPERTIES as readonly Property[]) {
    let v: string | null | undefined;
    if (p === 'text-decoration') v = joinTextDecoration(values.get('text-decoration-line'), values.get('text-decoration-style'), values.get('text-decoration-color'));
    else if (p === 'overflow') v = joinOverflow(values.get('overflow-x'), values.get('overflow-y'));
    else v = values.get(p);
    if (v != null && safe(v)) { style[p] = v; any = true; }
  }
  return any ? style : null;
}

/** the runtime's own check, as a last gate: what it would refuse is never written */
const safe = (v: string) => !/\\|url\(|image\(|image-set\(/i.test(v);
