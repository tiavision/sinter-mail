// Media queries (Media Queries Level 4), evaluated once, at parse time, for one of two fixed screens:
// 'wide' is an 800 × 600 px landscape viewport, 'narrow' a 375 × 667 px portrait one, both at 1 dppx with
// a 16 px root font, colour, no hover information, in the light colour scheme (or the dark one: css/index.ts
// resolves an email whose styles change with `prefers-color-scheme` in both). There is no stylesheet to
// re-evaluate them later, so a query is a constant. Anything this does not know (a feature, a unit, a malformed query) is
// false, as a browser treats a query it cannot parse as `not all`.
import { parseComponents, type CV } from './tokenize.js';

export type Media = 'wide' | 'narrow';
export type Scheme = 'light' | 'dark';

interface Screen {
  width: number;
  height: number;
  scheme: Scheme;
}
const SIZES: Record<Media, { width: number; height: number }> = { wide: { width: 800, height: 600 }, narrow: { width: 375, height: 667 } };

/** a media query list (`@media`'s prelude, a `media` attribute): true when any query matches */
export function matchMedia(list: CV[] | string, media: Media, scheme: Scheme = 'light'): boolean {
  const items = typeof list === 'string' ? parseComponents(list) : list;
  const queries = split(items);
  // an empty list matches everything
  if (queries.length === 1 && queries[0].length === 0) return true;
  const screen: Screen = { ...SIZES[media], scheme };
  return queries.some((q) => query(q, screen) === true);
}

/** split at top-level commas, whitespace trimmed */
function split(items: CV[]): CV[][] {
  const out: CV[][] = [[]];
  for (const v of items) {
    if (v.t === ',') out.push([]);
    else if (v.t !== 'ws') out[out.length - 1].push(v);
  }
  return out;
}

// three-valued logic: true, false, or null (unknown), which a query as a whole reads as false
type K = boolean | null;
const not = (v: K): K => (v === null ? null : !v);

const TYPES_TRUE = new Set(['all', 'screen']);
const TYPES_FALSE = new Set(['print', 'tty', 'tv', 'projection', 'handheld', 'braille', 'embossed', 'aural', 'speech']);
const RESERVED = new Set(['only', 'not', 'and', 'or', 'layer']);

function query(q: CV[], screen: Screen): K {
  if (q.length === 0) return false;
  const first = q[0];
  if ((first.t === 'block' && first.open === '(') || (first.t === 'ident' && first.v.toLowerCase() === 'not' && q[1]?.t === 'block')) {
    return condition(q, 0, screen, true) ?? false;
  }
  // [not | only]? <media-type> [and <condition-without-or>]?
  let i = 0;
  let negate = false;
  const kw = (v: CV | undefined) => (v?.t === 'ident' ? v.v.toLowerCase() : null);
  if (kw(q[0]) === 'not') { negate = true; i++; } else if (kw(q[0]) === 'only') i++;
  const type = kw(q[i]);
  if (type === null || RESERVED.has(type)) return false;
  i++;
  let r: K = TYPES_TRUE.has(type) ? true : TYPES_FALSE.has(type) ? false : false;
  if (i < q.length) {
    if (kw(q[i]) !== 'and' || i + 1 >= q.length) return false;
    const c = condition(q, i + 1, screen, false);
    if (c === undefined) return false;
    r = r === false ? false : c === false ? false : r === true && c === true ? true : null;
  }
  return negate ? not(r) : r;
}

/**
 * A media condition from `q[i]` to the end: `not <in-parens>`, or in-parens joined by `and` (or `or`
 * when `or` is allowed: not after a media type). undefined when malformed.
 */
function condition(q: CV[], i: number, screen: Screen, orAllowed: boolean): K | undefined {
  const kw = (v: CV | undefined) => (v?.t === 'ident' ? v.v.toLowerCase() : null);
  if (kw(q[i]) === 'not') {
    if (i + 2 !== q.length) return undefined;
    const v = inParens(q[i + 1], screen);
    return v === undefined ? undefined : not(v);
  }
  let r = inParens(q[i], screen);
  if (r === undefined) return undefined;
  let op: string | null = null;
  for (let j = i + 1; j < q.length; j += 2) {
    const k = kw(q[j]);
    if ((k !== 'and' && k !== 'or') || (op && k !== op) || (k === 'or' && !orAllowed)) return undefined;
    op = k;
    const v = inParens(q[j + 1], screen);
    if (v === undefined) return undefined;
    if (k === 'and') r = r === false || v === false ? false : r === true && v === true ? true : null;
    else r = r === true || v === true ? true : r === false && v === false ? false : null;
  }
  return r;
}

/** `( <condition> )` or `( <feature> )`; a parenthesized thing that is neither is unknown */
function inParens(v: CV | undefined, screen: Screen): K | undefined {
  if (!v || v.t !== 'block' || v.open !== '(') {
    // a function here is <general-enclosed>: unknown
    return v?.t === 'func' ? null : undefined;
  }
  const items = v.items.filter((x) => x.t !== 'ws');
  if (items.length === 0) return undefined;
  if (items[0].t === 'block' || (items[0].t === 'ident' && items[0].v.toLowerCase() === 'not')) {
    const c = condition(items, 0, screen, true);
    return c === undefined ? null : c;
  }
  return feature(items, screen);
}

// the features this knows, as numbers in px (lengths), plain numbers, or keywords
type Value = { n: number; kind: 'length' | 'number' | 'ratio' | 'resolution' } | { kw: string };

function featureValue(name: string, screen: Screen): Value | null {
  switch (name) {
    case 'width': case 'device-width': return { n: screen.width, kind: 'length' };
    case 'height': case 'device-height': return { n: screen.height, kind: 'length' };
    case 'aspect-ratio': case 'device-aspect-ratio': return { n: screen.width / screen.height, kind: 'ratio' };
    case 'orientation': return { kw: screen.width > screen.height ? 'landscape' : 'portrait' };
    case 'prefers-color-scheme': return { kw: screen.scheme };
    case 'prefers-reduced-motion': case 'prefers-reduced-transparency': return { kw: 'no-preference' };
    case 'prefers-contrast': return { kw: 'no-preference' };
    case 'forced-colors': return { kw: 'none' };
    case 'color': return { n: 8, kind: 'number' };
    case 'color-index': case 'monochrome': case 'grid': return { n: 0, kind: 'number' };
    case 'resolution': return { n: 1, kind: 'resolution' };
    case '-webkit-device-pixel-ratio': return { n: 1, kind: 'number' };
    case 'scan': return { kw: 'progressive' };
    default: return null;
  }
}

const RANGE = new Set(['width', 'height', 'device-width', 'device-height', 'aspect-ratio', 'device-aspect-ratio', 'color', 'color-index', 'monochrome', 'resolution', '-webkit-device-pixel-ratio']);

function feature(items: CV[], screen: Screen): K {
  const id = (v: CV | undefined) => (v?.t === 'ident' ? v.v.toLowerCase() : null);
  // (name)
  if (items.length === 1) {
    const name = id(items[0]);
    if (name === null) return null;
    const f = featureValue(name, screen);
    if (!f) return null;
    return 'n' in f ? f.n !== 0 : f.kw !== 'none' && f.kw !== 'no-preference';
  }
  // (name: value), with min-/max- prefixes
  if (items[1].t === ':') {
    let name = id(items[0]);
    if (name === null) return null;
    let cmp: '=' | '>=' | '<=' = '=';
    const prefix = /^(-webkit-)?(min|max)-/.exec(name);
    if (prefix) {
      cmp = prefix[2] === 'min' ? '>=' : '<=';
      name = (prefix[1] ?? '') + name.slice(prefix[0].length);
    }
    const f = featureValue(name, screen);
    if (!f || (prefix && !RANGE.has(name))) return null;
    const rest = items.slice(2);
    if ('kw' in f) return rest.length === 1 && id(rest[0]) === f.kw ? true : rest.length === 1 && rest[0].t === 'ident' ? false : null;
    const v = valueOf(rest, f.kind);
    return v === null ? null : compare(f.n, cmp, v);
  }
  // range syntax: (name op value), (value op name), (value op name op value)
  const ops: { op: string; at: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const v = items[i];
    if (v.t === 'delim' && (v.v === '<' || v.v === '>' || v.v === '=')) {
      let op = v.v;
      const next = items[i + 1];
      if (op !== '=' && next?.t === 'delim' && next.v === '=') { op += '='; i++; }
      ops.push({ op, at: i });
    }
  }
  if (ops.length < 1 || ops.length > 2) return null;
  const parts: CV[][] = [];
  let from = 0;
  for (const o of ops) {
    parts.push(items.slice(from, o.at - (o.op.length - 1)));
    from = o.at + 1;
  }
  parts.push(items.slice(from));
  const nameAt = parts.findIndex((p) => p.length === 1 && id(p[0]) !== null && featureValue(id(p[0])!, screen) !== null);
  if (nameAt < 0) return null;
  const name = id(parts[nameAt][0])!;
  const f = featureValue(name, screen)!;
  if ('kw' in f || !RANGE.has(name)) return null;
  if (ops.length === 2) {
    // both ops point the same way, neither is `=`, and the name is in the middle
    if (nameAt !== 1 || ops[0].op[0] !== ops[1].op[0] || ops[0].op === '=' || ops[1].op === '=') return null;
  }
  let r: K = true;
  for (let k = 0; k < ops.length; k++) {
    const left = parts[k];
    const right = parts[k + 1];
    const op = ops[k].op as '<' | '<=' | '>' | '>=' | '=';
    // the comparison as "feature op value"
    if (k + 1 === nameAt) {
      const v = valueOf(left, f.kind);
      if (v === null) return null;
      const flipped = ({ '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=' } as const)[op];
      r = r && compare(f.n, flipped, v);
    } else if (k === nameAt) {
      const v = valueOf(right, f.kind);
      if (v === null) return null;
      r = r && compare(f.n, op, v);
    } else return null;
  }
  return r;
}

function compare(a: number, op: '<' | '<=' | '>' | '>=' | '=', b: number): boolean {
  // a little tolerance, so a ratio computed in floating point compares equal to the one written
  const eq = Math.abs(a - b) < 1e-9;
  switch (op) {
    case '=': return eq;
    case '<': return a < b && !eq;
    case '<=': return a < b || eq;
    case '>': return a > b && !eq;
    case '>=': return a > b || eq;
  }
}

const PX: Record<string, number> = { px: 1, em: 16, rem: 16, ex: 8, ch: 8, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };
const DPPX: Record<string, number> = { dppx: 1, x: 1, dpi: 1 / 96, dpcm: 2.54 / 96 };

/** a feature's value in the feature's unit (px, a plain number, a ratio, dppx), or null */
function valueOf(items: CV[], kind: 'length' | 'number' | 'ratio' | 'resolution'): number | null {
  if (kind === 'ratio') {
    if (items.length === 1 && items[0].t === 'number' && items[0].n >= 0) return items[0].n;
    if (items.length === 3 && items[0].t === 'number' && items[1].t === 'delim' && items[1].v === '/' && items[2].t === 'number') {
      const a = items[0].n;
      const b = items[2].n;
      if (a < 0 || b < 0) return null;
      return b === 0 ? Infinity : a / b;
    }
    return null;
  }
  if (items.length !== 1) return null;
  const v = items[0];
  if (kind === 'length') {
    if (v.t === 'number' && v.n === 0) return 0;
    if (v.t === 'dimension') {
      const k = PX[v.unit.toLowerCase()];
      return k === undefined ? null : v.n * k;
    }
    return null;
  }
  if (kind === 'resolution') {
    if (v.t !== 'dimension') return null;
    const k = DPPX[v.unit.toLowerCase()];
    return k === undefined ? null : v.n * k;
  }
  return v.t === 'number' ? v.n : null;
}
