// Presentational hints: the legacy attributes email still uses (bgcolor, align, cellpadding, <font>…)
// as the declarations a browser maps them to (HTML, "Rendering"), at the lowest precedence of the
// author's styles. Where the standard leaves room, this follows Chromium, measured
// (test/css.browser.test.ts): `align` on a div, a paragraph or a table part is `-webkit-center` (which
// also centres the blocks inside, as a centred email's table needs), table cells take the table's
// `border` and `cellpadding`, rows and sections pass their `valign` to their cells.
import { attr, type RawElement } from '../raw.js';
import type { Info } from './selectors.js';
import { expand, isNamedColor, num, type Assignment, type Longhand } from './values.js';

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const sides = (what: 'width' | 'style' | 'color', v: string): Assignment[] => SIDES.map((s) => [`border-${s}-${what}` as Longhand, v]);
const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';

/** HTML's rules for parsing a legacy colour value: `#rrggbb`, a name, or null */
export function legacyColor(input: string): string | null {
  let s = input;
  // strip leading and trailing ASCII whitespace
  let a = 0, b = s.length;
  while (a < b && isWs(s[a])) a++;
  while (b > a && isWs(s[b - 1])) b--;
  s = s.slice(a, b);
  if (s === '') return null;
  const lower = s.toLowerCase();
  if (lower === 'transparent') return null;
  if (isNamedColor(lower)) return lower;
  if (s.length === 4 && s[0] === '#' && /^[0-9a-f]{3}$/i.test(s.slice(1))) {
    const [r, g, bl] = s.slice(1).toLowerCase();
    return `#${r}${r}${g}${g}${bl}${bl}`;
  }
  // characters beyond the BMP count as "00"; then at most 128 code units
  s = Array.from(s, (ch) => (ch.length > 1 ? '00' : ch)).join('').slice(0, 128);
  if (s[0] === '#') s = s.slice(1);
  s = s.replace(/[^0-9a-f]/gi, '0');
  while (s.length === 0 || s.length % 3 !== 0) s += '0';
  let len = s.length / 3;
  let parts = [s.slice(0, len), s.slice(len, 2 * len), s.slice(2 * len)];
  if (len > 8) { parts = parts.map((p) => p.slice(len - 8)); len = 8; }
  while (len > 2 && parts.every((p) => p[0] === '0')) { parts = parts.map((p) => p.slice(1)); len--; }
  if (len > 2) parts = parts.map((p) => p.slice(0, 2));
  return '#' + parts.map((p) => p.padStart(2, '0')).join('').toLowerCase();
}

// once, not per call: dimension() and integer() run for most legacy attributes
const DIMENSION = /^[ \t\n\f\r]*(\d+(?:\.\d+)?|\.\d+)(%?)/;
const INTEGER = /^[ \t\n\f\r]*\+?(\d+)/;

/** HTML's rules for parsing a dimension value: px or % as a CSS value, or null; `nonzero` drops 0 */
export function dimension(input: string | null, nonzero = false): string | null {
  if (input === null) return null;
  const m = DIMENSION.exec(input);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || (nonzero && n === 0)) return null;
  return num(n) + (m[2] ? '%' : n === 0 ? '' : 'px');
}

/** HTML's rules for parsing a non-negative integer, or null */
export function integer(input: string | null): number | null {
  if (input === null) return null;
  const m = INTEGER.exec(input);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

// <font size>: 1 to 7 (or ±n from 3), as the standard's keywords x-small … xxx-large, written in px
const FONT_SIZES = ['10px', '13px', '16px', '18px', '24px', '32px', '48px'];

/** HTML's rules for parsing a legacy font size */
export function legacyFontSize(input: string): string | null {
  const m = /^[ \t\n\f\r]*([+-]?)(\d+)/.exec(input);
  if (!m) return null;
  let v = Number(m[2].slice(0, 9));
  if (m[1] === '+') v = 3 + v;
  else if (m[1] === '-') v = 3 - v;
  return FONT_SIZES[Math.min(7, Math.max(1, v)) - 1];
}

const lower = (el: RawElement, name: string) => attr(el, name)?.trim().toLowerCase() ?? null;

/** `align` on a block or a table part, as Chromium maps it */
function blockAlign(v: string | null, webkit: boolean): string | null {
  switch (v) {
    case 'center': case 'middle': return webkit ? '-webkit-center' : 'center';
    case 'left': return webkit ? '-webkit-left' : 'left';
    case 'right': return webkit ? '-webkit-right' : 'right';
    case 'justify': return 'justify';
    case 'absmiddle': return webkit ? 'center' : null;
    default: return null;
  }
}

function valign(v: string | null): string | null {
  return v === 'top' || v === 'middle' || v === 'bottom' || v === 'baseline' ? v : null;
}

const SECTIONS = new Set(['thead', 'tbody', 'tfoot']);

/** a cell's row, its row's section and its table, as the parser builds them */
function tableOf(cell: Info): { row: Info | null; section: Info | null; table: Info | null } {
  const row = cell.parent?.el.tag === 'tr' ? cell.parent : null;
  const up = row?.parent ?? null;
  const section = up && SECTIONS.has(up.el.tag) ? up : null;
  const t = section ? section.parent : up;
  return { row, section, table: t?.el.tag === 'table' ? t : null };
}

/** what the body passes down: its `link` colour, for links */
export interface HintContext {
  link: string | null;
}

const push = (out: Assignment[], p: Longhand, v: string | null) => { if (v !== null) out.push([p, v]); };
const bg = (out: Assignment[], el: RawElement) => { const v = attr(el, 'bgcolor'); if (v !== null) push(out, 'background-color', legacyColor(v)); };
const wh = (out: Assignment[], el: RawElement, nonzero: boolean) => {
  push(out, 'width', dimension(attr(el, 'width'), nonzero));
  push(out, 'height', dimension(attr(el, 'height'), nonzero));
};

// <img align>'s vertical alignments
const VA: Record<string, string> = { top: 'top', middle: 'middle', absmiddle: 'middle', center: 'middle', bottom: 'baseline', absbottom: 'bottom', baseline: 'baseline', texttop: 'text-top' };

/** no hints: shared, never written to */
const NONE: readonly Assignment[] = [];

/** the presentational hints of an element, in the order they apply */
export function hints(e: Info, cx: HintContext): readonly Assignment[] {
  const el = e.el;
  // every hint comes from an attribute but <center>'s and what a cell takes from its table
  if (el.attrs.length === 0 && el.tag !== 'center' && el.tag !== 'td' && el.tag !== 'th') return NONE;
  const out: Assignment[] = [];
  switch (el.tag) {
    case 'body': {
      bg(out, el);
      const text = attr(el, 'text');
      if (text !== null) push(out, 'color', legacyColor(text));
      const mw = dimension(attr(el, 'marginwidth'));
      const mh = dimension(attr(el, 'marginheight'));
      push(out, 'margin-left', dimension(attr(el, 'leftmargin')) ?? mw);
      push(out, 'margin-right', dimension(attr(el, 'rightmargin')) ?? mw);
      push(out, 'margin-top', dimension(attr(el, 'topmargin')) ?? mh);
      push(out, 'margin-bottom', dimension(attr(el, 'bottommargin')) ?? mh);
      break;
    }
    case 'a':
      if (cx.link && attr(el, 'href') !== null) push(out, 'color', cx.link);
      break;
    case 'p': case 'div':
      push(out, 'text-align', blockAlign(lower(el, 'align'), true));
      break;
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      push(out, 'text-align', blockAlign(lower(el, 'align'), false));
      break;
    case 'center':
      push(out, 'text-align', '-webkit-center');
      break;
    case 'caption': {
      const a = lower(el, 'align');
      if (a === 'top' || a === 'bottom') push(out, 'caption-side', a);
      break;
    }
    case 'br': {
      const c = lower(el, 'clear');
      push(out, 'clear', c === 'all' || c === 'both' ? 'both' : c === 'left' || c === 'right' || c === 'none' ? c : null);
      break;
    }
    case 'table': {
      bg(out, el);
      wh(out, el, true);
      const a = lower(el, 'align');
      if (a === 'center') { push(out, 'margin-left', 'auto'); push(out, 'margin-right', 'auto'); }
      else if (a === 'left' || a === 'right') push(out, 'float', a);
      const border = tableBorder(el);
      const bc = attr(el, 'bordercolor');
      const bcolor = bc !== null ? legacyColor(bc) : null;
      if (border !== null) {
        out.push(...sides('width', border + 'px'));
        if (border > 0) out.push(...sides('style', bcolor ? 'solid' : 'outset'));
      }
      if (bcolor) out.push(...sides('color', bcolor));
      const sp = integer(attr(el, 'cellspacing'));
      if (sp !== null) push(out, 'border-spacing', num(sp) + 'px');
      break;
    }
    case 'thead': case 'tbody': case 'tfoot': case 'tr':
      bg(out, el);
      push(out, 'text-align', blockAlign(lower(el, 'align'), true));
      push(out, 'vertical-align', valign(lower(el, 'valign')));
      push(out, 'height', dimension(attr(el, 'height'), true));
      break;
    case 'col': case 'colgroup':
      bg(out, el);
      push(out, 'width', dimension(attr(el, 'width'), true));
      break;
    case 'td': case 'th': {
      const { row, section, table } = tableOf(e);
      // what the cell takes from its table, below its own attributes
      if (table) {
        const border = tableBorder(table.el);
        if (border !== null && border > 0) {
          const solid = attr(table.el, 'bordercolor') !== null && legacyColor(attr(table.el, 'bordercolor')!) !== null;
          out.push(...sides('width', '1px'), ...sides('style', solid ? 'solid' : 'inset'), ...sides('color', 'inherit'));
        }
        // present and not a number is 0, as Chromium reads it
        const cp = attr(table.el, 'cellpadding');
        const pad = cp === null ? null : integer(cp) ?? 0;
        if (pad !== null) for (const s of SIDES) push(out, `padding-${s}`, num(pad) + 'px');
      }
      bg(out, el);
      wh(out, el, true);
      push(out, 'text-align', blockAlign(lower(el, 'align'), true));
      push(out, 'vertical-align', valign(lower(el, 'valign')) ?? (row && valign(lower(row.el, 'valign'))) ?? (section && valign(lower(section.el, 'valign'))));
      if (attr(el, 'nowrap') !== null) push(out, 'white-space', 'nowrap');
      break;
    }
    case 'img': {
      wh(out, el, false);
      const a = lower(el, 'align');
      if (a === 'left' || a === 'right') { push(out, 'float', a); push(out, 'vertical-align', 'top'); }
      else {
        if (a !== null && a in VA) push(out, 'vertical-align', VA[a]);
      }
      const b = dimension(attr(el, 'border'));
      if (b !== null) { out.push(...sides('width', b === '0' ? '0' : b), ...sides('style', 'solid')); }
      const hs = dimension(attr(el, 'hspace'));
      const vs = dimension(attr(el, 'vspace'));
      if (hs !== null) { push(out, 'margin-left', hs); push(out, 'margin-right', hs); }
      if (vs !== null) { push(out, 'margin-top', vs); push(out, 'margin-bottom', vs); }
      break;
    }
    case 'hr': {
      const a = lower(el, 'align');
      if (a === 'left') { push(out, 'margin-left', '0'); push(out, 'margin-right', 'auto'); }
      else if (a === 'right') { push(out, 'margin-left', 'auto'); push(out, 'margin-right', '0'); }
      else if (a === 'center') { push(out, 'margin-left', 'auto'); push(out, 'margin-right', 'auto'); }
      push(out, 'width', dimension(attr(el, 'width'), true));
      const c = attr(el, 'color');
      const cv = c !== null ? legacyColor(c) : null;
      if (cv) out.push(...sides('style', 'solid'), ...sides('color', cv), ['background-color', cv]);
      else if (attr(el, 'noshade') !== null) out.push(...sides('style', 'solid'), ...sides('color', 'gray'), ['background-color', 'gray']);
      const size = attr(el, 'size');
      if (size !== null) {
        const n = integer(size) ?? 0;
        if (n <= 1) push(out, 'border-bottom-width', '0');
        else push(out, 'height', num(n - 2) + 'px');
      }
      break;
    }
    case 'font': {
      const c = attr(el, 'color');
      if (c !== null) push(out, 'color', legacyColor(c));
      const face = attr(el, 'face');
      if (face !== null) {
        const f = expand('font-family', face);
        if (f && !['inherit', 'initial', 'unset'].includes(f[0][1])) out.push(...f);
      }
      const size = attr(el, 'size');
      if (size !== null) push(out, 'font-size', legacyFontSize(size));
      break;
    }
  }
  return out;
}

/** a table's `border` attribute in px: present and not a number is 1 */
function tableBorder(table: RawElement): number | null {
  const v = attr(table, 'border');
  if (v === null) return null;
  return integer(v) ?? 1;
}
