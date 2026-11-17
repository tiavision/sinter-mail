// The tag table: what an email may contain. The single source for parse.ts (what is kept, dropped or
// renamed), for the tree's `Tag` type (test/components.test.ts checks they agree) and for the generated
// components (scripts/build-components.mjs writes sinter/components/internal/ from it).
import type { Attrs, Property, Tag } from './sinter.types.js';

type AttrName = keyof Attrs;

// ── Properties ────────────────────────────────────────────────────────────────────────────────────────
// The properties the cascade keeps (sinter/css checks and re-serializes each value). Grouped by where they
// do something, so each generated component binds only the properties that apply to its element.

export const TEXT: readonly Property[] = [
  'color', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant', 'line-height',
  'letter-spacing', 'word-spacing', 'text-align', 'text-decoration', 'text-transform', 'text-indent',
  'white-space', 'word-break', 'overflow-wrap',
];
export const BOX: readonly Property[] = [
  'background-color', 'display', 'vertical-align', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'overflow', 'opacity', 'box-sizing', 'float', 'clear',
];
export const TABLE: readonly Property[] = ['border-collapse', 'border-spacing', 'table-layout', 'caption-side'];
export const LIST: readonly Property[] = ['list-style-type', 'list-style-position'];

/** every property the cascade keeps */
export const PROPERTIES: readonly Property[] = [...TEXT, ...BOX, ...TABLE, ...LIST];

// ── Attributes ────────────────────────────────────────────────────────────────────────────────────────
// Kept as attributes, literal keys in the components. The legacy presentational attributes (bgcolor,
// align, valign, border, cellpadding, cellspacing, <font color face size>, width and height but on
// images) are read by the cascade and become styles; they are not attributes of the tree.

const GLOBAL: readonly AttrName[] = ['dir', 'lang', 'title', 'id'];

// ── Tags ──────────────────────────────────────────────────────────────────────────────────────────────

export interface TagInfo {
  /** attributes beyond GLOBAL */
  attrs: readonly AttrName[];
  /** the properties its component binds */
  props: readonly Property[];
  /** void: no children */
  void?: true;
  /**
   * rendered inside its table's component, never on its own: the HTML parser would move a component's
   * tag written inside a <table> out of it (foster parenting), so a table's structure is one component
   */
  inTable?: true;
}

const FLOW = [...TEXT, ...BOX];
const t = (attrs: readonly AttrName[] = [], props: readonly Property[] = FLOW, extra: Partial<TagInfo> = {}): TagInfo => ({ attrs, props, ...extra });

export const TAGS: Record<Tag, TagInfo> = {
  a: t(['href']),
  abbr: t(),
  address: t(),
  article: t(),
  aside: t(),
  b: t(),
  bdi: t(),
  bdo: t(),
  blockquote: t(['cite']),
  br: t([], ['clear'], { void: true }),
  caption: t([], [...FLOW, ...TABLE], { inTable: true }),
  center: t(),
  cite: t(),
  code: t(),
  col: t(['span'], ['width', 'background-color', 'border-left-width', 'border-right-width', 'border-left-style', 'border-right-style', 'border-left-color', 'border-right-color'], { void: true, inTable: true }),
  colgroup: t(['span'], ['width', 'background-color'], { inTable: true }),
  dd: t(),
  del: t(['cite', 'datetime']),
  details: t(['open']),
  dfn: t(),
  div: t(),
  dl: t(),
  dt: t(),
  em: t(),
  figcaption: t(),
  figure: t(),
  font: t(),
  footer: t(),
  h1: t(), h2: t(), h3: t(), h4: t(), h5: t(), h6: t(),
  header: t(),
  hr: t([], FLOW, { void: true }),
  i: t(),
  img: t(['src', 'alt', 'width', 'height'], BOX, { void: true }),
  ins: t(['cite', 'datetime']),
  kbd: t(),
  li: t(['value'], [...FLOW, ...LIST]),
  main: t(),
  mark: t(),
  nav: t(),
  ol: t(['start', 'reversed', 'type'], [...FLOW, ...LIST]),
  p: t(),
  pre: t(),
  q: t(['cite']),
  s: t(),
  samp: t(),
  section: t(),
  small: t(),
  span: t(),
  strike: t(),
  strong: t(),
  sub: t(),
  summary: t(),
  sup: t(),
  table: t([], [...FLOW, ...TABLE]),
  tbody: t([], FLOW, { inTable: true }),
  td: t(['colspan', 'rowspan', 'headers', 'abbr'], FLOW, { inTable: true }),
  tfoot: t([], FLOW, { inTable: true }),
  th: t(['colspan', 'rowspan', 'headers', 'scope', 'abbr'], FLOW, { inTable: true }),
  thead: t([], FLOW, { inTable: true }),
  time: t(['datetime']),
  tr: t([], FLOW, { inTable: true }),
  tt: t(),
  u: t(),
  ul: t(['type'], [...FLOW, ...LIST]),
  var: t(),
  wbr: t([], [], { void: true }),
};

/** the attributes a tag keeps, GLOBAL included */
export const attrsOf = (tag: Tag): readonly AttrName[] => [...GLOBAL, ...TAGS[tag].attrs];

// ── What is not kept ──────────────────────────────────────────────────────────────────────────────────

/**
 * Dropped with everything inside: what runs, embeds, submits or describes the document rather than
 * being its content.
 */
export const DROP: ReadonlySet<string> = new Set([
  'script', 'style', 'template', 'noscript', 'noembed', 'noframes', 'iframe', 'frame', 'frameset', 'object',
  'embed', 'applet', 'param', 'video', 'audio', 'source', 'track', 'canvas', 'map', 'area', 'picture',
  'form', 'input', 'button', 'select', 'option', 'optgroup', 'datalist', 'textarea', 'output', 'progress',
  'meter', 'keygen', 'link', 'meta', 'base', 'basefont', 'title', 'head', 'dialog', 'slot', 'portal',
  'marquee', 'blink', 'xmp', 'plaintext', 'listing', 'image', 'math', 'svg',
]);

/**
 * Kept as another allowed tag, children included: elements the browser renders as that tag would, so the
 * email looks the same. Any other unknown element (`o:p`, `custom-tag`, `label`) is a `span`, as the
 * browser renders an unknown element: inline, with its styles.
 */
// `<html>` and `<body>` are not elements of the tree: the body's children are the Body's, and its style
// is the Body's (parse.ts).
export const RENAME: Readonly<Record<string, Tag>> = {
  fieldset: 'div',
  legend: 'div',
  hgroup: 'div',
  menu: 'ul',
  dir: 'ul',
  big: 'span',
  nobr: 'span',
  label: 'span',
  data: 'span',
  ruby: 'span',
  rb: 'span',
  rp: 'span',
  rt: 'span',
  rtc: 'span',
  acronym: 'abbr',
  search: 'div',
};
