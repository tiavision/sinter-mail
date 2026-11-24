// Values: each declaration checked against its property's grammar and re-serialized from its tokens, or
// dropped. Shorthands are expanded here into the longhands the cascade keeps (sinter/tags.ts,
// PROPERTIES), so a later longhand and an earlier shorthand meet in one place, in declaration order.
//
// What is kept is a simple form of what browsers accept: lengths in absolute and font-relative units,
// percentages, colours, keywords, font lists. Not kept: viewport units (the email's box is not the
// viewport), math functions, `var()`, `env()`, `attr()`, images and any other function, negative margins
// (an email must not reach outside its box over the app: a small negative margin-bottom is tracked here, and
// index.ts, finish, writes it as 0 or as the vertical-align that lowers an image as far), vendor-prefixed
// properties. A kept value
// never contains a backslash or a function the runtime refuses: strings are re-quoted from their decoded
// characters, and the only functions written are rgb(), rgba(), hsl() and hsla() with numbers in them.
import type { Property } from '../sinter.types.js';
import { parseComponents, type CV, type Func } from './tokenize.js';

/**
 * What the cascade tracks: the kept properties, the longhands of the two kept properties that are
 * shorthands in CSS (`text-decoration`, `overflow`), joined back when the element's style is written, and
 * `color-scheme`, read on the email's `<html>` and `<body>` (the schemes it is written for) and never kept.
 */
export type Longhand =
  | Exclude<Property, 'text-decoration' | 'overflow'>
  | 'text-decoration-line' | 'text-decoration-style' | 'text-decoration-color'
  | 'overflow-x' | 'overflow-y'
  | 'color-scheme';

export type Assignment = [Longhand, string];

const WIDE = new Set(['inherit', 'initial', 'unset']);

// ── Numbers, lengths, colours ────────────────────────────────────────────────────────────────────────

/** a number as CSS writes it: at most four decimals, no `-0` */
export function num(n: number): string {
  const r = Math.round(n * 1e4) / 1e4;
  return r === 0 ? '0' : String(r);
}

// the units kept, with their size in px for the bound on small negative values
/**
 * `o` as a table with no prototype, for the ones looked up by what the email wrote (a unit, a property's name):
 * `constructor` and `__proto__` are names an email may write, and are in none of them.
 */
const table = <T extends object>(o: T): T => Object.assign(Object.create(null), o);
const UNITS = table<Record<string, number>>({ px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, em: 16, rem: 16, ex: 8, ch: 8 });

interface LengthOptions {
  /** a percentage is allowed */
  pct?: boolean;
  /**
   * negative values: invalid (the default, as for widths and paddings), down to about one em ('small'),
   * or written as 0 ('clamp': valid CSS that would move the box out, as a negative margin)
   */
  neg?: 'small' | 'clamp';
}

/** a length (or percentage, or unitless 0), re-serialized; null otherwise */
export function length(v: CV | undefined, o: LengthOptions = {}): string | null {
  if (!v) return null;
  if (v.t === 'number') return v.n === 0 ? '0' : null;
  let n: number;
  let unit: string;
  if (v.t === 'dimension') {
    unit = v.unit.toLowerCase();
    if (!(unit in UNITS)) return null;
    n = v.n;
  } else if (v.t === 'percentage' && o.pct) {
    unit = '%';
    n = v.n;
  } else return null;
  if (!Number.isFinite(n)) return null;
  if (n < 0) {
    if (o.neg === 'clamp') return '0';
    if (o.neg !== 'small') return null;
    // about one em: a heading's tightened letter-spacing, an icon nudged down, not a box moved away
    if (unit === '%' ? n < -100 : n * UNITS[unit] < -16) return null;
  }
  return num(n) + unit;
}

const NAMED = new Set(
  ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue ' +
    'chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey ' +
    'darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray ' +
    'darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen ' +
    'fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen ' +
    'lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime ' +
    'limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue ' +
    'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive ' +
    'olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue ' +
    'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke ' +
    'yellow yellowgreen').split(' '),
);

// system colours, the deprecated ones included: Outlook writes `windowtext` in every border
const SYSTEM = new Set(
  ('activeborder activecaption appworkspace background buttonface buttonhighlight buttonshadow buttontext captiontext graytext ' +
    'highlight highlighttext inactiveborder inactivecaption inactivecaptiontext infobackground infotext menu menutext scrollbar ' +
    'threeddarkshadow threedface threedhighlight threedlightshadow threedshadow window windowframe windowtext canvas canvastext ' +
    'linktext visitedtext activetext buttonborder field fieldtext mark marktext selecteditem selecteditemtext accentcolor accentcolortext').split(' '),
);

/** whether `name` (lowercase) is a named colour */
export const isNamedColor = (name: string): boolean => NAMED.has(name);

const isHex = (s: string) => /^[0-9a-fA-F]+$/.test(s);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** a colour, re-serialized: a name, `#hex` (lowercase), rgb()/rgba()/hsl()/hsla() with plain numbers */
export function color(v: CV | undefined): string | null {
  if (!v) return null;
  if (v.t === 'ident') {
    const k = v.v.toLowerCase();
    return NAMED.has(k) || SYSTEM.has(k) || k === 'transparent' || k === 'currentcolor' ? k : null;
  }
  if (v.t === 'hash') {
    const h = v.v;
    return isHex(h) && (h.length === 3 || h.length === 4 || h.length === 6 || h.length === 8) ? '#' + h.toLowerCase() : null;
  }
  if (v.t === 'func') {
    const name = v.name.toLowerCase();
    if (name === 'rgb' || name === 'rgba') return rgb(v);
    if (name === 'hsl' || name === 'hsla') return hsl(v);
  }
  return null;
}

/** a colour function's arguments: legacy (comma-separated, 3 or 4) or modern (space-separated, `/ alpha`) */
function channels(f: Func): { legacy: boolean; c: CV[]; alpha: CV | null } | null {
  const xs = f.args.filter((x) => x.t !== 'ws');
  if (xs.some((x) => x.t === ',')) {
    // legacy: a, b, c[, alpha]
    const c: CV[] = [];
    for (let i = 0; i < xs.length; i += 2) {
      c.push(xs[i]);
      if (i + 1 < xs.length && xs[i + 1].t !== ',') return null;
    }
    if (xs.length % 2 === 0 || (c.length !== 3 && c.length !== 4)) return null;
    return { legacy: true, c: c.slice(0, 3), alpha: c[3] ?? null };
  }
  if (xs.length === 3) return { legacy: false, c: xs, alpha: null };
  if (xs.length === 5 && xs[3].t === 'delim' && xs[3].v === '/') return { legacy: false, c: xs.slice(0, 3), alpha: xs[4] };
  return null;
}

const isNone = (v: CV) => v.t === 'ident' && v.v.toLowerCase() === 'none';

function alphaOf(v: CV | null, legacy: boolean): number | null {
  if (!v) return 1;
  if (v.t === 'number' && Number.isFinite(v.n)) return clamp(v.n, 0, 1);
  if (v.t === 'percentage' && Number.isFinite(v.n)) return clamp(v.n / 100, 0, 1);
  if (!legacy && isNone(v)) return 0;
  return null;
}

function rgb(f: Func): string | null {
  const ch = channels(f);
  if (!ch) return null;
  const { legacy, c } = ch;
  // legacy syntax: all numbers or all percentages
  if (legacy && !(c.every((x) => x.t === 'number') || c.every((x) => x.t === 'percentage'))) return null;
  const out: number[] = [];
  for (const x of c) {
    if (x.t === 'number' && Number.isFinite(x.n)) out.push(clamp(x.n, 0, 255));
    else if (x.t === 'percentage' && Number.isFinite(x.n)) out.push(clamp(x.n * 2.55, 0, 255));
    else if (!legacy && isNone(x)) out.push(0);
    else return null;
  }
  const a = alphaOf(ch.alpha, legacy);
  if (a === null) return null;
  const body = out.map(num).join(', ');
  return a === 1 ? `rgb(${body})` : `rgba(${body}, ${num(a)})`;
}

const ANGLE = table<Record<string, number>>({ deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 });

function hsl(f: Func): string | null {
  const ch = channels(f);
  if (!ch) return null;
  const { legacy, c } = ch;
  const [h, s, l] = c;
  let hue: number;
  if (h.t === 'number' && Number.isFinite(h.n)) hue = h.n;
  else if (h.t === 'dimension' && h.unit.toLowerCase() in ANGLE && Number.isFinite(h.n)) hue = h.n * ANGLE[h.unit.toLowerCase()];
  else if (!legacy && isNone(h)) hue = 0;
  else return null;
  const pct = (x: CV): number | null => {
    if (x.t === 'percentage' && Number.isFinite(x.n)) return clamp(x.n, 0, 100);
    if (!legacy && x.t === 'number' && Number.isFinite(x.n)) return clamp(x.n, 0, 100);
    if (!legacy && isNone(x)) return 0;
    return null;
  };
  const sat = pct(s);
  const lig = pct(l);
  const a = alphaOf(ch.alpha, legacy);
  if (sat === null || lig === null || a === null) return null;
  hue = ((hue % 360) + 360) % 360;
  const body = `${num(hue)}, ${num(sat)}%, ${num(lig)}%`;
  return a === 1 ? `hsl(${body})` : `hsla(${body}, ${num(a)})`;
}

// ── Keywords ─────────────────────────────────────────────────────────────────────────────────────────

const kw = (v: CV | undefined): string | null => (v?.t === 'ident' ? v.v.toLowerCase() : null);
const oneOf = (words: string) => {
  const set = new Set(words.split(' '));
  return (v: CV | undefined) => {
    const k = kw(v);
    return k !== null && set.has(k) ? k : null;
  };
};

const BORDER_STYLE = oneOf('none hidden dotted dashed solid double groove ridge inset outset');
const BORDER_WIDTH = (v: CV | undefined) => oneOf('thin medium thick')(v) ?? length(v);
const FONT_SIZE = (v: CV | undefined) => oneOf('xx-small x-small small medium large x-large xx-large xxx-large larger smaller')(v) ?? length(v, { pct: true });
const LINE_HEIGHT = (v: CV | undefined): string | null => {
  if (kw(v) === 'normal') return 'normal';
  if (v?.t === 'number' && Number.isFinite(v.n) && v.n >= 0) return num(v.n);
  return length(v, { pct: true });
};
const FONT_WEIGHT = (v: CV | undefined): string | null => {
  const k = oneOf('normal bold bolder lighter')(v);
  if (k) return k;
  return v?.t === 'number' && v.n >= 1 && v.n <= 1000 ? num(v.n) : null;
};
const FONT_STYLE = oneOf('normal italic oblique');
const FONT_VARIANT = oneOf('normal none small-caps all-small-caps petite-caps all-petite-caps unicase titling-caps');
const OVERFLOW = oneOf('visible hidden clip scroll auto');
const SIZE_KEYWORDS = 'min-content max-content fit-content';
const box = (extra: string) => (v: CV | undefined) => oneOf(`${extra} ${SIZE_KEYWORDS}`)(v) ?? length(v, { pct: true });
const LIST_TYPES = oneOf(
  'disc circle square disclosure-open disclosure-closed decimal decimal-leading-zero lower-roman upper-roman lower-greek ' +
    'lower-alpha lower-latin upper-alpha upper-latin armenian georgian hebrew cjk-decimal cjk-ideographic hiragana katakana ' +
    'hiragana-iroha katakana-iroha arabic-indic bengali devanagari persian thai lower-armenian upper-armenian none',
);
const listType = (v: CV | undefined): string | null => (v?.t === 'string' ? quote(v.v) : LIST_TYPES(v));

/** a string re-quoted from its decoded characters; null when it cannot be written without an escape */
export function quote(s: string): string | null {
  // control characters would need an escape; text the runtime refuses is refused here first
  if (/[\u0000-\u001f\u007f\\]/.test(s) || /url\(|image\(|image-set\(/i.test(s)) return null;
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// the single-value longhands: each a check of the one component value
type Check = (v: CV | undefined) => string | null;

/**
 * margin-bottom: a negative length down to about one em is tracked as written, for finish (index.ts) to write
 * as 0 or as an image's vertical-align (`margin-bottom: -6px`, an icon lowered onto the middle of its line);
 * a larger one, or a negative percentage, is 0 as every negative margin is
 */
const MARGIN_BOTTOM: Check = (v) => (kw(v) === 'auto' ? 'auto' : length(v, { neg: 'small' }) ?? length(v, { pct: true, neg: 'clamp' }));

const SINGLE = table<Partial<Record<Longhand, Check>>>({
  color,
  'background-color': color,
  'font-size': FONT_SIZE,
  'font-style': FONT_STYLE,
  'font-weight': FONT_WEIGHT,
  'font-variant': FONT_VARIANT,
  'line-height': LINE_HEIGHT,
  'letter-spacing': (v) => (kw(v) === 'normal' ? 'normal' : length(v, { neg: 'small' })),
  'word-spacing': (v) => (kw(v) === 'normal' ? 'normal' : length(v, { neg: 'small' })),
  'text-align': oneOf('left right center justify start end match-parent -webkit-center -webkit-left -webkit-right'),
  'text-transform': oneOf('none capitalize uppercase lowercase full-width full-size-kana'),
  'text-indent': (v) => length(v, { pct: true, neg: 'clamp' }),
  'white-space': oneOf('normal nowrap pre pre-wrap pre-line break-spaces'),
  'vertical-align': (v) => oneOf('baseline sub super text-top text-bottom middle top bottom')(v) ?? length(v, { pct: true, neg: 'small' }),
  'word-break': oneOf('normal break-all keep-all break-word'),
  'overflow-wrap': oneOf('normal break-word anywhere'),
  width: box('auto'),
  height: box('auto'),
  'min-width': box('auto'),
  'min-height': box('auto'),
  'max-width': box('none'),
  'max-height': box('none'),
  'margin-top': (v) => (kw(v) === 'auto' ? 'auto' : length(v, { pct: true, neg: 'clamp' })),
  'margin-right': (v) => (kw(v) === 'auto' ? 'auto' : length(v, { pct: true, neg: 'clamp' })),
  'margin-bottom': MARGIN_BOTTOM,
  'margin-left': (v) => (kw(v) === 'auto' ? 'auto' : length(v, { pct: true, neg: 'clamp' })),
  'padding-top': (v) => length(v, { pct: true }),
  'padding-right': (v) => length(v, { pct: true }),
  'padding-bottom': (v) => length(v, { pct: true }),
  'padding-left': (v) => length(v, { pct: true }),
  'border-top-width': BORDER_WIDTH,
  'border-right-width': BORDER_WIDTH,
  'border-bottom-width': BORDER_WIDTH,
  'border-left-width': BORDER_WIDTH,
  'border-top-style': BORDER_STYLE,
  'border-right-style': BORDER_STYLE,
  'border-bottom-style': BORDER_STYLE,
  'border-left-style': BORDER_STYLE,
  'border-top-color': color,
  'border-right-color': color,
  'border-bottom-color': color,
  'border-left-color': color,
  'border-collapse': oneOf('collapse separate'),
  'table-layout': oneOf('auto fixed'),
  'caption-side': oneOf('top bottom'),
  display: oneOf(
    'block inline inline-block none flex inline-flex grid inline-grid list-item flow-root table inline-table table-row-group ' +
      'table-header-group table-footer-group table-row table-cell table-column-group table-column table-caption',
  ),
  'list-style-type': listType,
  'list-style-position': oneOf('inside outside'),
  opacity: (v) => (v?.t === 'number' && Number.isFinite(v.n) ? num(clamp(v.n, 0, 1)) : v?.t === 'percentage' && Number.isFinite(v.n) ? num(clamp(v.n / 100, 0, 1)) : null),
  'box-sizing': oneOf('content-box border-box'),
  float: oneOf('left right none'),
  clear: oneOf('left right both none'),
  'text-decoration-style': oneOf('solid double dotted dashed wavy'),
  'text-decoration-color': color,
  'overflow-x': OVERFLOW,
  'overflow-y': OVERFLOW,
});

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;

/** 1 to 4 values to top, right, bottom, left, as CSS repeats them */
function fourSides(xs: CV[], check: Check, name: (side: (typeof SIDES)[number]) => Longhand): Assignment[] | null {
  if (xs.length < 1 || xs.length > 4) return null;
  const vs: string[] = [];
  for (const x of xs) {
    const v = check(x);
    if (v === null) return null;
    vs.push(v);
  }
  const [t, r = t, b = t, l = r] = vs;
  return [[name('top'), t], [name('right'), r], [name('bottom'), b], [name('left'), l]];
}

// ── Shorthands ───────────────────────────────────────────────────────────────────────────────────────

/** the longhands each shorthand sets, for CSS-wide keywords */
const SHORTHANDS = table<Record<string, Longhand[]>>({
  margin: SIDES.map((s) => `margin-${s}` as Longhand),
  padding: SIDES.map((s) => `padding-${s}` as Longhand),
  'border-width': SIDES.map((s) => `border-${s}-width` as Longhand),
  'border-style': SIDES.map((s) => `border-${s}-style` as Longhand),
  'border-color': SIDES.map((s) => `border-${s}-color` as Longhand),
  border: SIDES.flatMap((s) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`] as Longhand[]),
  ...Object.fromEntries(SIDES.map((s) => [`border-${s}`, [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`] as Longhand[]])),
  'border-radius': CORNERS.map((c) => `border-${c}-radius` as Longhand),
  background: ['background-color'],
  font: ['font-style', 'font-variant', 'font-weight', 'font-size', 'line-height', 'font-family'],
  'list-style': ['list-style-type', 'list-style-position'],
  overflow: ['overflow-x', 'overflow-y'],
  'text-decoration': ['text-decoration-line', 'text-decoration-style', 'text-decoration-color'],
  'text-decoration-line': ['text-decoration-line'],
  'font-family': ['font-family'],
  'border-spacing': ['border-spacing'],
  'word-wrap': ['overflow-wrap'],
  'color-scheme': ['color-scheme'],
  ...Object.fromEntries(CORNERS.map((c) => [`border-${c}-radius`, [`border-${c}-radius` as Longhand]])),
});

/**
 * The longhands a declaration sets, its value re-serialized; null when the property is not kept or the
 * value is invalid or unsafe (the declaration is then ignored, as an invalid one is by a browser).
 */
export function expand(name: string, value: CV[] | string): Assignment[] | null {
  const items = typeof value === 'string' ? parseComponents(value) : value;
  const xs = items.filter((x) => x.t !== 'ws');
  if (xs.length === 0) return null;
  const single = SINGLE[name as Longhand];
  const longhands = SHORTHANDS[name] ?? (single ? [name as Longhand] : null);
  if (!longhands) return null;
  // inherit, initial, unset: for every longhand (revert and revert-layer are not kept: they would reach
  // the page's own styles in a way the email's author did not see)
  if (xs.length === 1) {
    const k = kw(xs[0]);
    if (k !== null && WIDE.has(k)) return longhands.map((l) => [l, k]);
  }
  if (single) {
    if (xs.length !== 1) return null;
    const v = single(xs[0]);
    return v === null ? null : [[name as Longhand, v]];
  }
  switch (name) {
    case 'margin': {
      // every side checked as margin-bottom, then the other sides' negatives written as 0
      const a = fourSides(xs, MARGIN_BOTTOM, (s) => `margin-${s}` as Longhand);
      return a && a.map(([l, v]) => [l, l !== 'margin-bottom' && v[0] === '-' ? '0' : v]);
    }
    case 'padding': return fourSides(xs, SINGLE['padding-top']!, (s) => `padding-${s}` as Longhand);
    case 'border-width': return fourSides(xs, BORDER_WIDTH, (s) => `border-${s}-width` as Longhand);
    case 'border-style': return fourSides(xs, BORDER_STYLE, (s) => `border-${s}-style` as Longhand);
    case 'border-color': return fourSides(xs, color, (s) => `border-${s}-color` as Longhand);
    case 'border': return border(xs, SIDES);
    case 'border-top': return border(xs, ['top']);
    case 'border-right': return border(xs, ['right']);
    case 'border-bottom': return border(xs, ['bottom']);
    case 'border-left': return border(xs, ['left']);
    case 'border-radius': return borderRadius(xs);
    case 'border-top-left-radius': case 'border-top-right-radius': case 'border-bottom-right-radius': case 'border-bottom-left-radius': {
      const v = corner(xs);
      return v === null ? null : [[name, v]];
    }
    case 'border-spacing': {
      if (xs.length > 2) return null;
      const vs = xs.map((x) => length(x));
      return vs.includes(null) ? null : [['border-spacing', vs.join(' ')]];
    }
    case 'background': return background(items);
    case 'font': return font(items);
    case 'font-family': {
      const v = fontFamily(items);
      return v === null ? null : [['font-family', v]];
    }
    case 'list-style': return listStyle(xs);
    case 'overflow': {
      if (xs.length > 2) return null;
      const x = OVERFLOW(xs[0]);
      const y = xs.length === 2 ? OVERFLOW(xs[1]) : x;
      return x === null || y === null ? null : [['overflow-x', x], ['overflow-y', y]];
    }
    case 'text-decoration': return textDecoration(xs, true);
    case 'text-decoration-line': return textDecoration(xs, false);
    case 'word-wrap': {
      const v = xs.length === 1 ? SINGLE['overflow-wrap']!(xs[0]) : null;
      return v === null ? null : [['overflow-wrap', v]];
    }
    case 'color-scheme': {
      const v = colorScheme(xs);
      return v === null ? null : [['color-scheme', v]];
    }
  }
  return null;
}

/**
 * `color-scheme`: `normal`, or the schemes (`light`, `dark`, names of others) with `only` before or after
 * them; written as the known schemes, `light dark` in that order, or `normal` when it names neither
 */
function colorScheme(xs: CV[]): string | null {
  const names = xs.map(kw);
  if (names.includes(null)) return null;
  if (names.length === 1 && names[0] === 'normal') return 'normal';
  if (names.includes('normal') || names.filter((n) => n === 'only').length > 1) return null;
  if (names.indexOf('only') > 0 && names.indexOf('only') < names.length - 1) return null;
  const known = (['light', 'dark'] as const).filter((s) => names.includes(s));
  if (names.filter((n) => n !== 'only').length === 0) return null;
  return known.length ? known.join(' ') : 'normal';
}

/** `border` and `border-<side>`: width || style || colour, each at most once; the rest initial */
function border(xs: CV[], sides: readonly (typeof SIDES)[number][]): Assignment[] | null {
  if (xs.length > 3) return null;
  let w: string | null = null, s: string | null = null, c: string | null = null;
  for (const x of xs) {
    let v: string | null;
    if (s === null && (v = BORDER_STYLE(x)) !== null) s = v;
    else if (w === null && (v = BORDER_WIDTH(x)) !== null) w = v;
    else if (c === null && (v = color(x)) !== null) c = v;
    else return null;
  }
  return sides.flatMap((side): Assignment[] => [
    [`border-${side}-width`, w ?? 'medium'],
    [`border-${side}-style`, s ?? 'none'],
    [`border-${side}-color`, c ?? 'currentcolor'],
  ]);
}

const RADIUS = (v: CV | undefined) => length(v, { pct: true });

/** one corner: one radius, or a horizontal and a vertical one */
function corner(xs: CV[]): string | null {
  if (xs.length > 2) return null;
  const vs = xs.map(RADIUS);
  if (vs.includes(null)) return null;
  return vs.length === 2 && vs[0] === vs[1] ? vs[0] : vs.join(' ');
}

/** `border-radius`: 1–4 horizontal radii, then optionally `/` and 1–4 vertical ones, per corner */
function borderRadius(xs: CV[]): Assignment[] | null {
  const slash = xs.findIndex((x) => x.t === 'delim' && x.v === '/');
  const h = slash < 0 ? xs : xs.slice(0, slash);
  const v = slash < 0 ? null : xs.slice(slash + 1);
  const expandFour = (ys: CV[]): string[] | null => {
    if (ys.length < 1 || ys.length > 4) return null;
    const out = ys.map(RADIUS);
    if (out.includes(null)) return null;
    const [a, b = a, c = a, d = b] = out as string[];
    return [a, b, c, d];
  };
  const hs = expandFour(h);
  const vs = v ? expandFour(v) : hs;
  if (!hs || !vs) return null;
  return CORNERS.map((c, i): Assignment => [`border-${c}-radius` as Longhand, hs[i] === vs[i] ? hs[i] : `${hs[i]} ${vs[i]}`]);
}

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong']);
const NOT_FAMILY = new Set(['inherit', 'initial', 'unset', 'default', 'revert', 'revert-layer']);

/**
 * A font-family list: each family a string or a run of identifiers, written back as a string (a generic
 * family as its keyword). A family that cannot be written without an escape is left out of the list.
 */
export function fontFamily(items: CV[]): string | null {
  const out: string[] = [];
  let part: CV[] = [];
  const flush = (): boolean => {
    const xs = part.filter((x) => x.t !== 'ws');
    part = [];
    if (xs.length === 0) return false;
    if (xs.length === 1 && xs[0].t === 'string') {
      const q = quote(xs[0].v);
      if (q !== null) out.push(q);
      return true;
    }
    if (!xs.every((x) => x.t === 'ident')) return false;
    const words = xs.map((x) => (x as { v: string }).v);
    const first = words[0].toLowerCase();
    if (words.length === 1 && GENERIC.has(first)) { out.push(first); return true; }
    if (NOT_FAMILY.has(first)) return false;
    const q = quote(words.join(' '));
    if (q !== null) out.push(q);
    return true;
  };
  for (const v of items) {
    if (v.t === ',') { if (!flush()) return null; } else part.push(v);
  }
  if (!flush()) return null;
  return out.length ? out.join(', ') : null;
}

const STRETCH = new Set(['ultra-condensed', 'extra-condensed', 'condensed', 'semi-condensed', 'semi-expanded', 'expanded', 'extra-expanded', 'ultra-expanded']);
const SYSTEM_FONTS = new Set(['caption', 'icon', 'menu', 'message-box', 'small-caption', 'status-bar']);

/**
 * `font`: [style || variant || weight || stretch]? size [/ line-height]? family. It sets every font
 * longhand: what it does not name goes back to its initial value. System fonts are not kept.
 */
function font(items: CV[]): Assignment[] | null {
  const xs = items.filter((x) => x.t !== 'ws');
  if (xs.length === 1 && SYSTEM_FONTS.has(kw(xs[0]) ?? '')) return null;
  let style: string | null = null, variant: string | null = null, weight: string | null = null;
  let stretch = false;
  let i = 0;
  for (let n = 0; n < 4 && i < xs.length; n++) {
    const x = xs[i];
    const k = kw(x);
    if (k === 'normal') { i++; continue; }
    if (style === null && (k === 'italic' || k === 'oblique')) { style = k; i++; continue; }
    if (variant === null && k === 'small-caps') { variant = k; i++; continue; }
    if (weight === null && k !== null && ['bold', 'bolder', 'lighter'].includes(k)) { weight = k; i++; continue; }
    if (weight === null && x.t === 'number' && x.n >= 1 && x.n <= 1000) { weight = num(x.n); i++; continue; }
    if (!stretch && k !== null && STRETCH.has(k)) { stretch = true; i++; continue; }
    break;
  }
  const size = FONT_SIZE(xs[i]);
  if (size === null) return null;
  i++;
  let lineHeight = 'normal';
  if (xs[i]?.t === 'delim' && (xs[i] as { v: string }).v === '/') {
    const lh = LINE_HEIGHT(xs[i + 1]);
    if (lh === null) return null;
    lineHeight = lh;
    i += 2;
  }
  // the family is the rest of the original items, after the component values consumed
  const rest = items.slice(items.indexOf(xs[i - 1]) + 1);
  const family = fontFamily(rest);
  if (family === null) return null;
  return [
    ['font-style', style ?? 'normal'],
    ['font-variant', variant ?? 'normal'],
    ['font-weight', weight ?? 'normal'],
    ['font-size', size],
    ['line-height', lineHeight],
    ['font-family', family],
  ];
}

const BG_KEYWORDS = new Set([
  'none', 'repeat', 'repeat-x', 'repeat-y', 'no-repeat', 'space', 'round', 'scroll', 'fixed', 'local', 'left', 'right', 'top',
  'bottom', 'center', 'border-box', 'padding-box', 'content-box', 'text', 'auto', 'cover', 'contain',
]);
const IMAGE_FUNCTIONS = new Set([
  'url', 'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient',
  'repeating-conic-gradient', 'image-set', '-webkit-image-set', '-webkit-linear-gradient', '-webkit-radial-gradient',
  '-webkit-repeating-linear-gradient', '-webkit-repeating-radial-gradient', '-webkit-gradient', 'cross-fade', '-webkit-cross-fade',
]);

/**
 * `background`: only its colour is kept (images are not, in version 1), but the whole value is checked
 * as a browser would, so an invalid `background` does not reset the colour. A valid one without a
 * colour sets it to its initial value, `transparent`.
 */
function background(items: CV[]): Assignment[] | null {
  const xs = items.filter((x) => x.t !== 'ws');
  const layers: CV[][] = [[]];
  for (const x of xs) {
    if (x.t === ',') layers.push([]);
    else layers[layers.length - 1].push(x);
  }
  let c: string | null = null;
  for (let l = 0; l < layers.length; l++) {
    const layer = layers[l];
    if (layer.length === 0) return null;
    for (const x of layer) {
      const k = kw(x);
      if (k !== null && BG_KEYWORDS.has(k)) continue;
      if (x.t === 'url' || (x.t === 'func' && IMAGE_FUNCTIONS.has(x.name.toLowerCase()))) continue;
      if (x.t === 'delim' && x.v === '/') continue;
      // positions and sizes (a position may be negative)
      if ((x.t === 'number' && x.n === 0) || x.t === 'percentage' || (x.t === 'dimension' && x.unit.toLowerCase() in UNITS)) continue;
      const v = color(x);
      // a colour only once, and only in the last layer
      if (v !== null && c === null && l === layers.length - 1) { c = v; continue; }
      return null;
    }
  }
  return [['background-color', c ?? 'transparent']];
}

/** `list-style`: type || position || image; `none` sets whichever of type and image is not given */
function listStyle(xs: CV[]): Assignment[] | null {
  if (xs.length > 3) return null;
  let type: string | null = null, position: string | null = null;
  let image = false;
  let nones = 0;
  for (const x of xs) {
    const k = kw(x);
    if (k === 'none') { nones++; continue; }
    let v: string | null;
    if (position === null && (v = SINGLE['list-style-position']!(x)) !== null) position = v;
    else if (type === null && (v = listType(x)) !== null) type = v;
    else if (!image && (x.t === 'url' || (x.t === 'func' && IMAGE_FUNCTIONS.has(x.name.toLowerCase())))) image = true;
    else return null;
  }
  // `none` fills the type when nothing else did; two need both type and image free
  if (nones > 2 || (nones === 2 && (type !== null || image)) || (nones === 1 && type !== null && image)) return null;
  if (nones > 0 && type === null) type = 'none';
  return [['list-style-type', type ?? 'disc'], ['list-style-position', position ?? 'outside']];
}

const LINES = new Set(['underline', 'overline', 'line-through', 'blink']);

/**
 * `text-decoration` (line || style || colour || thickness; the thickness is checked and not kept) or,
 * with `shorthand` false, `text-decoration-line`.
 */
function textDecoration(xs: CV[], shorthand: boolean): Assignment[] | null {
  const lines: string[] = [];
  let none = false;
  let style: string | null = null, c: string | null = null, thickness = false;
  for (const x of xs) {
    const k = kw(x);
    let v: string | null;
    if (k === 'none' && !none && lines.length === 0) { none = true; continue; }
    if (k !== null && LINES.has(k) && !none && !lines.includes(k)) { lines.push(k); continue; }
    if (!shorthand) return null;
    if (style === null && (v = SINGLE['text-decoration-style']!(x)) !== null) { style = v; continue; }
    if (c === null && (v = color(x)) !== null) { c = v; continue; }
    if (!thickness && (k === 'auto' || k === 'from-font' || length(x, { pct: true }) !== null)) { thickness = true; continue; }
    return null;
  }
  const line = lines.length ? lines.join(' ') : none ? 'none' : null;
  if (!shorthand) return line === null ? null : [['text-decoration-line', line]];
  return [['text-decoration-line', line ?? 'none'], ['text-decoration-style', style ?? 'solid'], ['text-decoration-color', c ?? 'currentcolor']];
}

/** the `text-decoration` value from its tracked longhands, or null */
export function joinTextDecoration(line?: string, style?: string, c?: string): string | null {
  if (line === undefined && style === undefined && c === undefined) return null;
  // a CSS-wide keyword is written as itself when the other two are unset or the same keyword
  if (line !== undefined && WIDE.has(line)) return (style === undefined || style === line) && (c === undefined || c === line) ? line : null;
  const parts = [line ?? 'none'];
  if (style !== undefined && !WIDE.has(style) && style !== 'solid') parts.push(style);
  if (c !== undefined && !WIDE.has(c) && c !== 'currentcolor') parts.push(c);
  return parts.join(' ');
}

/** `overflow` from its tracked longhands: kept when both axes are the same (`clip` written as `hidden`) */
export function joinOverflow(x?: string, y?: string): string | null {
  const norm = (v: string | undefined) => (v === 'clip' ? 'hidden' : v ?? 'visible');
  if (x === undefined && y === undefined) return null;
  const a = norm(x);
  const b = norm(y);
  return a === b ? a : null;
}
