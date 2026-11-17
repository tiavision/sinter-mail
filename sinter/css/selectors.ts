// Selectors (Selectors Level 4): parsed from a rule's prelude, matched against the raw tree.
//
// Three outcomes for a selector list, as a browser has them: invalid (the whole rule is dropped, as CSS
// drops a rule with any invalid selector in its list), a selector this cannot match (valid CSS that
// depends on state a static email has no say in: `:hover`, `::before`, `:focus`; that selector never
// matches, the rest of the list still does), or a selector to match.
//
// Matching runs right to left over the parent pointers, with the three failure kinds of WebKit's
// SelectorChecker, so a chain of descendant combinators stays linear in the tree's depth.
import { attr, type RawElement } from '../raw.js';
import type { CV, Token } from './tokenize.js';

export type Combinator = ' ' | '>' | '+' | '~';

type Simple =
  | { k: 'tag'; v: string }
  | { k: 'id'; v: string }
  | { k: 'class'; v: string }
  | { k: 'attr'; name: string; op: '' | '=' | '~=' | '|=' | '^=' | '$=' | '*='; v: string; i: boolean }
  | { k: 'never' }
  | { k: 'root' | 'empty' | 'link' }
  | { k: 'nth'; last: boolean; type: boolean; a: number; b: number; of: Complex[] | null }
  | { k: 'not' | 'is'; list: Complex[] };

export interface Compound {
  simple: Simple[];
}

export interface Complex {
  /** compounds left to right */
  compounds: Compound[];
  /** combinators[i] sits between compounds[i] and compounds[i + 1] */
  combinators: Combinator[];
  /** packed (a, b, c) */
  specificity: number;
}

const spec = (a: number, b: number, c: number) => a * 1_000_000 + b * 1_000 + c;

class Invalid extends Error {}

// valid in Chromium, and never true of a static email (or of what it keeps of one)
const NEVER_CLASSES = new Set([
  'hover', 'active', 'focus', 'focus-within', 'focus-visible', 'visited', 'target', 'target-within', 'checked',
  'disabled', 'enabled', 'default', 'indeterminate', 'valid', 'invalid', 'in-range', 'out-of-range', 'required',
  'optional', 'read-only', 'read-write', 'placeholder-shown', 'autofill', '-webkit-autofill', 'fullscreen',
  'modal', 'picture-in-picture', 'playing', 'paused', 'defined', 'user-invalid', 'user-valid', 'open', 'popover-open',
  'host', 'current', 'past', 'future', 'blank', 'lang', 'dir', 'has', 'state', 'host-context',
  '-webkit-any', '-webkit-full-screen', 'window-inactive', 'horizontal', 'vertical', 'decrement', 'increment',
  'start', 'end', 'double-button', 'single-button', 'no-button', 'corner-present',
]);
const NEVER_ELEMENTS = new Set([
  'before', 'after', 'first-line', 'first-letter', 'selection', 'placeholder', 'marker', 'backdrop', 'file-selector-button',
  'cue', 'part', 'slotted', 'highlight', 'spelling-error', 'grammar-error', 'target-text', 'view-transition', 'search-text',
  'details-content', 'picker', 'column', 'scroll-marker', 'scroll-button',
]);
// the legacy pseudo-elements written with one colon
const LEGACY_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

const ws = (v: CV | undefined) => v?.t === 'ws';

/**
 * A rule prelude as a selector list: null when invalid (the rule is dropped); a selector this cannot
 * match is left out of the list, so the list can be empty.
 */
export function parseSelectorList(prelude: CV[]): Complex[] | null {
  try {
    return list(prelude, false, 0).filter((c) => !c.compounds.some(isNever));
  } catch (e) {
    if (e instanceof Invalid) return null;
    throw e;
  }
}

// a nesting bound: `:not(:not(…` deeper than this is invalid rather than a deep recursion
const MAX_DEPTH = 32;

function list(items: CV[], forgiving: boolean, depth: number): Complex[] {
  if (depth > MAX_DEPTH) throw new Invalid();
  const parts: CV[][] = [[]];
  for (const v of items) {
    if (v.t === ',') parts.push([]);
    else parts[parts.length - 1].push(v);
  }
  const out: Complex[] = [];
  for (const p of parts) {
    try {
      out.push(complex(p, depth));
    } catch (e) {
      if (!(e instanceof Invalid) || !forgiving) throw e;
    }
  }
  return out;
}

function isNever(c: Compound): boolean {
  return c.simple.some((s) => s.k === 'never');
}

function complex(items: CV[], depth: number): Complex {
  let i = 0;
  while (ws(items[i])) i++;
  let end = items.length;
  while (end > i && ws(items[end - 1])) end--;
  if (i >= end) throw new Invalid();
  const compounds: Compound[] = [];
  const combinators: Combinator[] = [];
  let a = 0, b = 0, c = 0;
  for (;;) {
    const r = compound(items, i, end, depth);
    compounds.push(r.compound);
    a += r.a; b += r.b; c += r.c;
    i = r.next;
    if (i >= end) break;
    // a combinator: whitespace, or `>`, `+`, `~` with whitespace around it
    let comb: Combinator = ' ';
    while (ws(items[i])) i++;
    const v = items[i];
    if (v.t === 'delim' && (v.v === '>' || v.v === '+' || v.v === '~')) {
      comb = v.v;
      i++;
      while (ws(items[i])) i++;
    }
    if (i >= end) throw new Invalid();
    combinators.push(comb);
  }
  return { compounds, combinators, specificity: spec(Math.min(a, 999), Math.min(b, 999), Math.min(c, 999)) };
}

interface Parsed {
  compound: Compound;
  next: number;
  a: number;
  b: number;
  c: number;
}

const isIdent = (v: CV | undefined): v is Extract<Token, { t: 'ident' }> => v?.t === 'ident';

function compound(items: CV[], i: number, end: number, depth: number): Parsed {
  const simple: Simple[] = [];
  let a = 0, b = 0, c = 0;
  const start = i;
  // a type or universal selector, with an optional namespace prefix (`*|`, `|`)
  const typeAt = (k: number): { name: string | null; next: number } | null => {
    const v = items[k];
    if (isIdent(v)) return { name: v.v.toLowerCase(), next: k + 1 };
    if (v?.t === 'delim' && v.v === '*') return { name: null, next: k + 1 };
    return null;
  };
  let t = typeAt(i);
  const bar = (k: number) => { const v = items[k]; return v?.t === 'delim' && v.v === '|'; };
  if (t && bar(t.next) && typeAt(t.next + 1)) {
    // `ns|type`: only `*|` is known without @namespace (which is not read); any other prefix is invalid
    if (t.name !== null) throw new Invalid();
    t = typeAt(t.next + 1);
  } else if (!t && bar(i) && typeAt(i + 1)) {
    // `|type`: elements in no namespace, which an HTML document has none of
    t = typeAt(i + 1);
    simple.push({ k: 'never' });
  }
  if (t) {
    if (t.name !== null) { simple.push({ k: 'tag', v: t.name }); c++; }
    i = t.next;
  }
  let pseudoElement = false;
  while (i < end) {
    const v = items[i];
    if (v.t === 'ws') break;
    if (v.t === 'delim' && (v.v === '>' || v.v === '+' || v.v === '~')) break;
    // after a pseudo-element, only pseudo-classes may follow (which, here, never match anyway)
    if (pseudoElement && v.t !== ':') throw new Invalid();
    if (v.t === 'hash') {
      if (!v.id) throw new Invalid();
      simple.push({ k: 'id', v: v.v });
      a++;
      i++;
    } else if (v.t === 'delim' && v.v === '.') {
      const n = items[i + 1];
      if (!isIdent(n)) throw new Invalid();
      simple.push({ k: 'class', v: n.v });
      b++;
      i += 2;
    } else if (v.t === 'block' && v.open === '[') {
      simple.push(attribute(v.items));
      b++;
      i++;
    } else if (v.t === ':') {
      const n = items[i + 1];
      if (n?.t === ':') {
        // a pseudo-element: valid ones never match, unknown ones (a vendor's, here) are invalid
        const p = items[i + 2];
        const name = isIdent(p) ? p.v.toLowerCase() : p?.t === 'func' ? p.name.toLowerCase() : null;
        if (name === null || !(NEVER_ELEMENTS.has(name) || name.startsWith('-webkit-'))) throw new Invalid();
        simple.push({ k: 'never' });
        c++;
        pseudoElement = true;
        i += 3;
        continue;
      }
      if (isIdent(n)) {
        const name = n.v.toLowerCase();
        i += 2;
        if (LEGACY_ELEMENTS.has(name)) { simple.push({ k: 'never' }); c++; pseudoElement = true; continue; }
        const s = pseudoClass(name);
        simple.push(s);
        if (s.k !== 'never' || NEVER_CLASSES.has(name)) b++;
        continue;
      }
      if (n?.t === 'func') {
        const r = pseudoFunction(n.name.toLowerCase(), n.args, depth);
        simple.push(r.simple);
        a += r.a; b += r.b; c += r.c;
        i += 2;
        continue;
      }
      throw new Invalid();
    } else if (v.t === 'delim' && v.v === '&') {
      // the nesting selector at the top level is :scope, which is :root here
      simple.push({ k: 'root' });
      b++;
      i++;
    } else throw new Invalid();
  }
  if (i === start) throw new Invalid();
  return { compound: { simple }, next: i, a, b, c };
}

function pseudoClass(name: string): Simple {
  switch (name) {
    // :scope, in a stylesheet, is the root
    case 'root': case 'scope': return { k: 'root' };
    case 'empty': return { k: 'empty' };
    case 'link': case 'any-link': case '-webkit-any-link': return { k: 'link' };
    case 'first-child': return { k: 'nth', last: false, type: false, a: 0, b: 1, of: null };
    case 'last-child': return { k: 'nth', last: true, type: false, a: 0, b: 1, of: null };
    case 'first-of-type': return { k: 'nth', last: false, type: true, a: 0, b: 1, of: null };
    case 'last-of-type': return { k: 'nth', last: true, type: true, a: 0, b: 1, of: null };
    case 'only-child': return { k: 'is', list: [single([{ k: 'nth', last: false, type: false, a: 0, b: 1, of: null }, { k: 'nth', last: true, type: false, a: 0, b: 1, of: null }])] };
    case 'only-of-type': return { k: 'is', list: [single([{ k: 'nth', last: false, type: true, a: 0, b: 1, of: null }, { k: 'nth', last: true, type: true, a: 0, b: 1, of: null }])] };
  }
  if (NEVER_CLASSES.has(name)) return { k: 'never' };
  throw new Invalid();
}

const single = (simple: Simple[]): Complex => ({ compounds: [{ simple }], combinators: [], specificity: 0 });

function maxSpec(list: Complex[]): number {
  let m = 0;
  for (const c of list) if (c.specificity > m) m = c.specificity;
  return m;
}
const unpack = (s: number) => ({ a: Math.floor(s / 1_000_000), b: Math.floor(s / 1_000) % 1_000, c: s % 1_000 });

function pseudoFunction(name: string, args: CV[], depth: number): { simple: Simple; a: number; b: number; c: number } {
  switch (name) {
    case 'not': {
      // a complex selector list, not forgiving; a selector in it that cannot be matched makes it unknowable
      const l = list(args, false, depth + 1);
      if (l.length === 0) throw new Invalid();
      const s = unpack(maxSpec(l));
      if (l.some((x) => x.compounds.some(isNever))) return { simple: { k: 'never' }, ...s };
      return { simple: { k: 'not', list: l }, ...s };
    }
    case 'is': case 'matches': case 'where': case '-webkit-any': {
      if (name === 'matches' || name === '-webkit-any') throw new Invalid();
      // forgiving: invalid selectors in it are left out; unmatchable ones never match, as an `or` of them
      const l = list(args, true, depth + 1).filter((x) => !x.compounds.some(isNever));
      const s = name === 'where' ? { a: 0, b: 0, c: 0 } : unpack(maxSpec(l));
      return { simple: l.length ? { k: 'is', list: l } : { k: 'never' }, ...s };
    }
    case 'nth-child': case 'nth-last-child': case 'nth-of-type': case 'nth-last-of-type': {
      const type = name.endsWith('of-type');
      // `An+B [of S]`, `of S` only for the -child forms
      let ofAt = -1;
      if (!type) ofAt = args.findIndex((v) => isIdent(v) && v.v.toLowerCase() === 'of');
      const ab = anb(ofAt < 0 ? args : args.slice(0, ofAt));
      if (!ab) throw new Invalid();
      let of: Complex[] | null = null;
      let s = { a: 0, b: 1, c: 0 };
      if (ofAt >= 0) {
        of = list(args.slice(ofAt + 1), false, depth + 1);
        if (of.length === 0) throw new Invalid();
        const m = unpack(maxSpec(of));
        s = { a: m.a, b: m.b + 1, c: m.c };
        if (of.some((x) => x.compounds.some(isNever))) return { simple: { k: 'never' }, ...s };
      }
      return { simple: { k: 'nth', last: name.includes('last'), type, a: ab.a, b: ab.b, of }, ...s };
    }
    case 'has': {
      // valid (a relative selector list) and not matched here
      return { simple: { k: 'never' }, a: 0, b: 0, c: 0 };
    }
    case 'lang': case 'dir': case 'host': case 'host-context': case 'state': case 'cue': case 'part': case 'slotted':
      return { simple: { k: 'never' }, a: 0, b: 1, c: 0 };
  }
  throw new Invalid();
}

/** the An+B microsyntax, read from the argument's own text */
function anb(items: CV[]): { a: number; b: number } | null {
  let text = '';
  for (const v of items) {
    switch (v.t) {
      case 'ws': text += ' '; break;
      case 'ident': text += v.v; break;
      case 'number': text += v.s; break;
      case 'dimension': text += v.s + v.unit; break;
      case 'delim': text += v.v; break;
      default: return null;
    }
  }
  text = text.trim().toLowerCase();
  if (text === 'odd') return { a: 2, b: 1 };
  if (text === 'even') return { a: 2, b: 0 };
  let m = /^([+-]?\d+)$/.exec(text);
  if (m) return { a: 0, b: Number(m[1]) };
  m = /^([+-]?)(\d*)n(?:\s*([+-])\s*(\d+)|([+-]\d+))?$/.exec(text);
  if (!m) return null;
  // a sign and digits are not separated from `n`; `+ n` (with a space) is not matched by the pattern
  const a = (m[1] === '-' ? -1 : 1) * (m[2] === '' ? 1 : Number(m[2]));
  const b = m[3] ? (m[3] === '-' ? -1 : 1) * Number(m[4]) : m[5] ? Number(m[5]) : 0;
  return { a, b };
}

const ATTR_OPS = new Set(['=', '~=', '|=', '^=', '$=', '*=']);

// the HTML attributes whose values selectors compare ASCII case-insensitively in an HTML document
const CASE_INSENSITIVE = new Set([
  'accept', 'accept-charset', 'align', 'alink', 'axis', 'bgcolor', 'charset', 'checked', 'clear', 'codetype', 'color',
  'compact', 'declare', 'defer', 'dir', 'direction', 'disabled', 'enctype', 'face', 'frame', 'hreflang', 'http-equiv',
  'lang', 'language', 'link', 'media', 'method', 'multiple', 'nohref', 'noresize', 'noshade', 'nowrap', 'readonly',
  'rel', 'rev', 'rules', 'scope', 'scrolling', 'selected', 'shape', 'target', 'text', 'type', 'valign', 'valuetype',
  'vlink',
]);

function attribute(items: CV[]): Simple {
  const xs = items.filter((v) => v.t !== 'ws');
  let i = 0;
  // an optional namespace prefix: `*|name` matches any; `|name` (no namespace) matches HTML attributes
  if (xs[i]?.t === 'delim' && (xs[i] as { v: string }).v === '*' && xs[i + 1]?.t === 'delim' && (xs[i + 1] as { v: string }).v === '|') i += 2;
  else if (xs[i]?.t === 'delim' && (xs[i] as { v: string }).v === '|') i += 1;
  const n = xs[i];
  if (!isIdent(n)) throw new Invalid();
  const name = n.v.toLowerCase();
  i++;
  if (i === xs.length) return { k: 'attr', name, op: '', v: '', i: false };
  // the operator: `=`, or one of `~|^$*` followed by `=` (with no whitespace between)
  let op = '';
  const d = xs[i];
  if (d.t !== 'delim') throw new Invalid();
  if (d.v === '=') { op = '='; i++; } else {
    const raw = items.indexOf(d);
    const eq = items[raw + 1];
    if (eq?.t !== 'delim' || eq.v !== '=') throw new Invalid();
    op = d.v + '=';
    i += 2;
  }
  if (!ATTR_OPS.has(op)) throw new Invalid();
  const val = xs[i];
  if (!val || (val.t !== 'ident' && val.t !== 'string')) throw new Invalid();
  i++;
  let insensitive = CASE_INSENSITIVE.has(name);
  const flag = xs[i];
  if (flag) {
    if (!isIdent(flag) || i + 1 !== xs.length) throw new Invalid();
    const f = flag.v.toLowerCase();
    if (f === 'i') insensitive = true;
    else if (f === 's') insensitive = false;
    else throw new Invalid();
  }
  return { k: 'attr', name, op: op as '=', v: insensitive ? asciiLower(val.v) : val.v, i: insensitive };
}

const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

// ── Matching ─────────────────────────────────────────────────────────────────────────────────────────

/** what matching needs of an element, computed once per tree */
export interface Info {
  el: RawElement;
  parent: Info | null;
  /** the parent's element children (the root alone for the root) */
  siblings: Info[];
  /** index among siblings */
  index: number;
  /** index among siblings of the same tag, and how many there are */
  typeIndex: number;
  typeCount: number;
  id: string | null;
  classes: string[];
}

/** every element of the tree, in document order, with its Info */
export function indexTree(root: RawElement): Info[] {
  const all: Info[] = [];
  const rootInfo = info(root, null, [], 0);
  rootInfo.siblings.push(rootInfo);
  rootInfo.typeCount = 1;
  // iterative: a deep tree must not exhaust the call stack
  const stack: Info[] = [rootInfo];
  while (stack.length) {
    const p = stack.pop()!;
    all.push(p);
    const kids: Info[] = [];
    for (const c of p.el.children) if (c.type === 'element') kids.push(info(c, p, kids, kids.length));
    const counts = new Map<string, number>();
    for (const k of kids) {
      const n = counts.get(k.el.tag) ?? 0;
      k.typeIndex = n;
      counts.set(k.el.tag, n + 1);
    }
    for (const k of kids) k.typeCount = counts.get(k.el.tag)!;
    for (let j = kids.length - 1; j >= 0; j--) stack.push(kids[j]);
  }
  return all;
}

function info(el: RawElement, parent: Info | null, siblings: Info[], index: number): Info {
  const cls = attr(el, 'class');
  return { el, parent, siblings, index, typeIndex: 0, typeCount: 0, id: attr(el, 'id'), classes: cls ? cls.split(/[ \t\n\f\r]+/).filter(Boolean) : [], };
}

const enum R { Match, FailLocal, FailSiblings, FailAll }

// The matching work left for this resolve, in compound tests. A hostile stylesheet can make every rule
// match every element, or every test walk to the root; past a budget no real email comes near
// (index.ts, MAX_STEPS), what is left does not match, so a resolve ends in bounded time.
let left = Infinity;

/** the work allowed for the next matches; returns what was left of the last budget */
export function budget(steps: number): number {
  const out = left;
  left = steps;
  return out;
}

/** whether the budget is spent: no further selector matches */
export const exhausted = (): boolean => left <= 0;

/** whether `sel` matches `e` */
export function matches(sel: Complex, e: Info): boolean {
  return step(sel, sel.compounds.length - 1, e) === R.Match;
}

function step(sel: Complex, k: number, e: Info): R {
  if (--left < 0) return R.FailAll;
  if (!compoundMatches(sel.compounds[k], e)) return R.FailLocal;
  if (k === 0) return R.Match;
  switch (sel.combinators[k - 1]) {
    case ' ': {
      for (let p = e.parent; p; p = p.parent) {
        const r = step(sel, k - 1, p);
        if (r === R.Match || r === R.FailAll) return r;
      }
      return R.FailAll;
    }
    case '>':
      return e.parent ? step(sel, k - 1, e.parent) : R.FailAll;
    case '+':
      return e.index > 0 ? step(sel, k - 1, e.siblings[e.index - 1]) : R.FailSiblings;
    case '~': {
      for (let j = e.index - 1; j >= 0; j--) {
        const r = step(sel, k - 1, e.siblings[j]);
        if (r === R.Match || r === R.FailSiblings || r === R.FailAll) return r;
      }
      return R.FailSiblings;
    }
  }
}

function compoundMatches(c: Compound, e: Info): boolean {
  for (const s of c.simple) if (!simpleMatches(s, e)) return false;
  return true;
}

function simpleMatches(s: Simple, e: Info): boolean {
  switch (s.k) {
    case 'tag': return e.el.tag === s.v;
    case 'id': return e.id === s.v;
    case 'class': return e.classes.includes(s.v);
    case 'attr': {
      const raw = attr(e.el, s.name);
      if (raw === null) return false;
      const v = s.i ? asciiLower(raw) : raw;
      switch (s.op) {
        case '': return true;
        case '=': return v === s.v;
        case '~=': return s.v !== '' && !/[ \t\n\f\r]/.test(s.v) && v.split(/[ \t\n\f\r]+/).includes(s.v);
        case '|=': return v === s.v || v.startsWith(s.v + '-');
        case '^=': return s.v !== '' && v.startsWith(s.v);
        case '$=': return s.v !== '' && v.endsWith(s.v);
        case '*=': return s.v !== '' && v.includes(s.v);
      }
      return false;
    }
    case 'never': return false;
    case 'root': return e.parent === null;
    case 'empty': return e.el.children.every((c) => c.type === 'text' && c.value === '');
    case 'link': return (e.el.tag === 'a' || e.el.tag === 'area') && attr(e.el, 'href') !== null;
    case 'not': return !s.list.some((x) => matches(x, e));
    case 'is': return s.list.some((x) => matches(x, e));
    case 'nth': {
      let pos: number;
      if (s.type) pos = s.last ? e.typeCount - e.typeIndex : e.typeIndex + 1;
      else if (s.of) {
        if (!s.of.some((x) => matches(x, e))) return false;
        pos = 1;
        const sib = e.siblings;
        if (s.last) { for (let j = e.index + 1; j < sib.length; j++) if (s.of.some((x) => matches(x, sib[j]))) pos++; }
        else for (let j = 0; j < e.index; j++) if (s.of.some((x) => matches(x, sib[j]))) pos++;
      } else pos = s.last ? e.siblings.length - e.index : e.index + 1;
      // pos = a·n + b for some n ≥ 0
      if (s.a === 0) return pos === s.b;
      const n = (pos - s.b) / s.a;
      return Number.isInteger(n) && n >= 0;
    }
  }
}

/** the key a selector is bucketed by: its rightmost compound's id, else a class, else its tag */
export function bucketKey(sel: Complex): string {
  const last = sel.compounds[sel.compounds.length - 1];
  let cls: string | null = null;
  let tag: string | null = null;
  for (const s of last.simple) {
    if (s.k === 'id') return '#' + s.v;
    if (s.k === 'class' && cls === null) cls = s.v;
    if (s.k === 'tag') tag = s.v;
  }
  return cls !== null ? '.' + cls : tag !== null ? tag : '*';
}
