// `mail.parse(html, options)`: an email's HTML body to the tree of sinter.types.ts.
//
// Three steps: the HTML parser builds the document the browser would build (sinter/parser), the cascade
// resolves every element's styles from its legacy attributes, the email's <style> rules and its style
// attribute (sinter/css), and this module keeps only what an email may contain (sinter/tags.ts): the
// allowed tags, their attributes with checked values, the images the options allow, ids only where an
// in-email link needs them, and a table structure the components can render.
//
// Pure: the same source and options give the same tree, with no globals beyond the language's and
// `URL`, so sinter runs it at build time over a `file:` resource. The tree is kept with sinter's memo():
// one parse per source and options, the tree frozen and shared.
import { parseHTML, resolve } from '@tiavision/sinter-mail/parser';
import type { RawElement, RawNode } from './raw.js';
import { attr } from './raw.js';
import { attrsOf, DROP, PROPERTIES, RENAME, TAGS, TEXT } from './tags.js';
import type { Attrs, Body, Element, Node, ParseOptions, Property, Style, Tag } from './sinter.types.js';

/**
 * The tree of an email's HTML body under `options`. The same source and options give the same tree,
 * frozen: change a copy.
 */
export function parse(html: string | null | undefined, options?: ParseOptions): Body {
  return last(typeof html === 'string' ? html : '', optionsOf(options));
}

/**
 * The tree of the call before, when this one has the same source and options. A let is its expression, read
 * at every binding, and memo()'s key holds the whole source (a 250 KB string built and hashed per read); this compares
 * the source by identity first (`===` on the same string is a pointer comparison). The state is in a closure, as memo's.
 */
const last = (() => {
  let h: string | undefined, p: ReturnType<typeof optionsOf> | undefined, v: Body | undefined;
  return (html: string, o: ReturnType<typeof optionsOf>): Body => {
    if (v && html === h && p && o.images === p.images && o.proxy === p.proxy && o.cidTemplate === p.cidTemplate && o.media === p.media && o.dataImages === p.dataImages
      && o.cidMap.length === p.cidMap.length && o.cidMap.every((x, i) => x === p!.cidMap[i])) return v;
    const r = parseTree(html, o.images, o.proxy, o.cidTemplate, o.cidMap, o.media, o.dataImages);
    h = html; p = o; v = r;
    return r;
  };
})();

/**
 * The parse, kept by its source and options: the source by identity (a Map hashes a string once), in order of
 * use, bounded by the sources' length; the tree frozen as memo() freezes one, by its known shape (no key list and no
 * descriptor per object).
 */
const parseTree = (() => {
  const MAX = 4 * 1024 * 1024;
  const cache = new Map<string, Map<string, Body>>();
  let total = 0;
  return (html: string, images: Images, proxy: string, cidTemplate: string, cidMap: string[], media: 'wide' | 'narrow', dataImages: number): Body => {
    const key = `${images}|${media}|${dataImages}|${proxy.length}:${proxy}|${cidTemplate.length}:${cidTemplate}|${cidMap.map((s) => `${s.length}:${s}`).join('')}`;
    let of = cache.get(html);
    if (of) { cache.delete(html); cache.set(html, of); } else { cache.set(html, (of = new Map())); total += html.length; }
    let v = of.get(key);
    if (!v) {
      of.set(key, (v = frozen(build(html, { images, proxy, cidTemplate, cidMap: pairs(cidMap), media, dataImages }))));
      for (const [k] of cache) { if (total <= MAX || k === html) break; cache.delete(k); total -= k.length; }
    }
    return v;
  };
})();

const F = Object.freeze;

/**
 * `body` frozen at every depth: its nodes, their attributes, styles and child lists are frozen as they are made
 * (element, nodesOf, projected), while they are still in the cache, rather than walked again; this freezes the rest.
 */
function frozen(body: Body): Body {
  F(body.style); F(body.images.origins); F(body.images);
  if (body.schemes) F(body.schemes);
  F(body.children);
  return F(body);
}

/** a void element's children: a list of its own, as every element has */
const NO_CHILDREN = (): Node[] => {
  const none: Node[] = [];
  F(none);
  return none;
};

type Images = 'block' | 'allow' | 'proxy';
interface Options {
  images: Images;
  proxy: string;
  /** a template with `{cid}`, or '' */
  cidTemplate: string;
  cidMap: Map<string, string>;
  media: 'wide' | 'narrow';
  dataImages: number;
}

// ── Options ───────────────────────────────────────────────────────────────────────────────────────────

const fail = (msg: string): never => {
  throw new TypeError(`mail.parse: ${msg}`);
};
const once = (s: string, part: string) => s.split(part).length === 2;

/** the options as primitives, validated: equal policies share one tree; an invalid one throws at each call */
function optionsOf(options: ParseOptions | undefined) {
  const o = options ?? {};
  const images = o.images ?? 'block';
  if (!['block', 'allow', 'proxy'].includes(images)) fail(`\`images\` is 'block', 'allow' or 'proxy', not ${JSON.stringify(images)}`);
  let proxy = '';
  if (images === 'proxy') {
    if (typeof o.proxy !== 'string' || !once(o.proxy, '{url}')) fail(`\`proxy\` is a URL template with \`{url}\` once, such as '/images?url={url}', not ${JSON.stringify(o.proxy)}`);
    if (!appUrl(o.proxy!.replace('{url}', 'x'))) fail(`\`proxy\` is a path on this site or an https: URL, not ${JSON.stringify(o.proxy)}`);
    proxy = o.proxy!;
  } else if (o.proxy !== undefined && typeof o.proxy !== 'string') fail('`proxy` is a string');
  let cidTemplate = '';
  const cidMap: string[] = [];
  if (typeof o.cid === 'string') {
    if (!once(o.cid, '{cid}') || !appUrl(o.cid.replace('{cid}', 'x'))) fail(`\`cid\` is a map or a URL template with \`{cid}\` once, not ${JSON.stringify(o.cid)}`);
    cidTemplate = o.cid;
  } else if (o.cid != null) {
    if (typeof o.cid !== 'object' || Array.isArray(o.cid)) fail('`cid` is a map from content id to URL, or a template with `{cid}`');
    for (const k of Object.keys(o.cid).sort()) {
      const v = (o.cid as Record<string, unknown>)[k];
      if (typeof v !== 'string') fail(`\`cid\`: the URL of ${JSON.stringify(k)} is not a string`);
      cidMap.push(contentId(k), v as string);
    }
  }
  const media = o.media ?? 'wide';
  if (media !== 'wide' && media !== 'narrow') fail(`\`media\` is 'wide' or 'narrow', not ${JSON.stringify(media)}`);
  const dataImages = o.dataImages ?? 65536;
  if (typeof dataImages !== 'number' || !Number.isInteger(dataImages) || dataImages < 0) fail(`\`dataImages\` is a length in characters, not ${JSON.stringify(dataImages)}`);
  return { images: images as Images, proxy, cidTemplate, cidMap, media: media as 'wide' | 'narrow', dataImages };
}

const pairs = (flat: string[]) => {
  const m = new Map<string, string>();
  for (let i = 0; i < flat.length; i += 2) m.set(flat[i], flat[i + 1]);
  return m;
};

/** a content id as `cid:` URLs and Content-ID headers write it, without `<>` and percent-encoding */
function contentId(s: string): string {
  let v = s.trim();
  if (v.startsWith('<') && v.endsWith('>')) v = v.slice(1, -1);
  try {
    v = decodeURIComponent(v);
  } catch {
    // a lone `%`: as written
  }
  return v;
}

// ── URLs ──────────────────────────────────────────────────────────────────────────────────────────────

/** an absolute URL with one of `schemes`, normalized by the URL standard (which strips what disguises a scheme), or null */
function absolute(value: string, schemes: readonly string[]): URL | null {
  if (!/^\s*[a-z][a-z\d+.-]*:/i.test(value)) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  return schemes.includes(u.protocol) ? u : null;
}

/**
 * A URL the app gave (a proxy, a `cid:` target): a path on the app's own site, an https: URL, or for
 * `cid:` maps a raster `data:` URL or a `blob:` URL. Never one an email wrote.
 */
function appUrl(value: string): boolean {
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return true;
  return absolute(value, ['https:', 'http:', 'blob:']) !== null || RASTER.test(value);
}

/** a raster image as a base64 `data:` URL: never SVG, which may hold script */
const RASTER = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z\d+/=\s]*$/i;

// ── The tree ──────────────────────────────────────────────────────────────────────────────────────────

interface Context {
  o: Options;
  /** the fragment names in-email links point to */
  targets: Set<string>;
  /** the ids given so far: the first element with an id keeps it, as the browser's getElementById finds it */
  ids: Set<string>;
  origins: Set<string>;
  styles: Map<RawElement, Style>;
  /** projected(): the style kept per resolved style and tag */
  projected: Map<Style, Map<Tag, Style>>;
  /** whether an element was marked as quoted history */
  quoted: boolean;
  /** Outlook's markers of a quote already started, and the elements around them: none starts another */
  started: Set<RawElement>;
  /** some element of the body is one of Outlook's markers (scan): otherwise no list is searched for one */
  outlook: boolean;
}

function build(html: string, o: Options): Body {
  const root = parseHTML(html);
  const { styles, colorScheme, dark } = resolve(root, { media: o.media });
  const body = root.children.find((n): n is RawElement => n.type === 'element' && n.tag === 'body');
  const cx: Context = { o, targets: new Set(), ids: new Set(), origins: new Set(), styles, projected: new Map(), quoted: false, started: new Set(), outlook: false };
  if (body) scan(body, cx);
  const children = body ? nodes(body, 'body', cx) : [];
  // the body's style is the root's: its text properties and its background, the <html> element's under it
  const style: Style = {};
  for (const el of [root, body]) {
    const s = el && styles.get(el);
    if (!s) continue;
    for (const p of ROOT_PROPS) if (s[p] !== undefined) style[p] = s[p];
  }
  const out: Body = { type: 'body', style, children, images: { origins: [...cx.origins].sort() } };
  // the schemes it is written for: what it declares, and dark too when its colours change with the scheme
  const schemes = (['light', 'dark'] as const).filter((s) => colorScheme.includes(s) || (s === 'dark' && dark));
  if (schemes.length) out.schemes = schemes;
  if (cx.quoted) out.quotes = true;
  // written for a white page: colours of its own, and no word that they work on a dark one
  if (!schemes.includes('dark') && colored(out)) out.light = true;
 
  return out;
}

/** whether the email sets a text or background colour anywhere it shows, its body included */
function colored(body: Body): boolean {
  if (body.style.color || body.style['background-color']) return true;
  const stack: Node[] = [...body.children];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'text' || n.style.display === 'none') continue;
    if (n.style.color || n.style['background-color']) return true;
    for (const c of n.children) stack.push(c);
  }
  return false;
}

const ROOT_PROPS: readonly Property[] = [...TEXT, 'background-color'];

/**
 * One pass over the body for what the rest needs to know of it first. The fragments in-email links point at
 * that the email has (an id, or an old-style `<a name>`): such a link keeps its href, and its target its id.
 * Every other id is left out, and every other fragment link loses its href. And whether any element is one
 * of Outlook's markers (isMarker), which most email has none of.
 */
function scan(body: RawElement, cx: Context): void {
  let linked: Set<string> | null = null;
  const named: string[] = [];
  const stack: RawElement[] = [body];
  while (stack.length) {
    const el = stack.pop()!;
    // the attributes read at once, the first of each name (as attr() reads them)
    let id: string | null = null, name: string | null = null, href: string | null = null, style: string | null = null;
    const a = el.attrs;
    for (let i = 0; i < a.length; i++) {
      switch (a[i][0]) {
        case 'id': id ??= a[i][1]; break;
        case 'name': name ??= a[i][1]; break;
        case 'href': href ??= a[i][1]; break;
        case 'style': style ??= a[i][1]; break;
      }
    }
    if (id) named.push(id);
    if (el.tag === 'a') {
      if (name) named.push(name);
      const h = href?.trim();
      if (h?.startsWith('#') && h.length > 1) (linked ??= new Set()).add(fragment(h));
    }
    if (!cx.outlook && isMarker(el.tag, id, style)) cx.outlook = true;
    for (const c of el.children) if (c.type === 'element') stack.push(c);
  }
  if (!linked) return;
  for (const n of named) if (linked.has(n)) cx.targets.add(n);
}

function fragment(href: string): string {
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return href.slice(1);
  }
}

/**
 * Where an element may stand inside a table (the components render a table's structure in one
 * component, so the tree must hold only these there; the HTML parser already builds this shape, and
 * this keeps it whatever a renamed or unknown element does)
 */
const TABLE_CHILDREN: Readonly<Record<string, ReadonlySet<Tag>>> = {
  table: new Set(['caption', 'colgroup', 'thead', 'tbody', 'tfoot']),
  colgroup: new Set(['col']),
  thead: new Set(['tr']),
  tbody: new Set(['tr']),
  tfoot: new Set(['tr']),
  tr: new Set(['td', 'th']),
};

/** the children of `el`, which became `tag` */
function nodes(el: RawElement, tag: string, cx: Context): Node[] {
  return nodesOf(el.children, tag, cx, 0);
}

/**
 * The nodes of `list`, children of a `tag`. Outlook writes no element around the history it quotes: from its marker
 * (searched from `from`) to the end of the parent, the rest of `list` is one `div` of `part: 'quote'`, the only element
 * the tree adds (a run of blocks to the end of its parent lays out the same in a div). Not in a table's structure.
 */
function nodesOf(list: readonly RawNode[], tag: string, cx: Context, from: number): Node[] {
  const allowed = TABLE_CHILDREN[tag];
  let marker = -1;
  if (!allowed && cx.outlook) {
    for (let k = from; k < list.length; k++) {
      const c = list[k]!;
      if (c.type === 'element' && startsRest(c, cx, 0)) { marker = k; break; }
    }
  }
  if (marker >= 0) {
    // its header: the marker and those right after it (appendonsend, the rule, divRplyFwdMsg), each with what wraps it
    for (let k = marker; k < list.length; k++) {
      const c = list[k]!;
      if (c.type === 'text') { if (c.value.trim()) break; continue; }
      const chain = startsRest(c, cx, 0);
      if (chain) { for (const e of chain) cx.started.add(e); continue; }
      if (c.tag !== 'hr') break;
    }
    // Outlook on the web draws a rule right before it
    let start = marker;
    for (let j = marker - 1; j >= 0; j--) {
      const c = list[j]!;
      if (c.type === 'text') { if (c.value.trim()) break; continue; }
      if (c.tag === 'hr') start = j;
      break;
    }
    cx.quoted = true;
    // in the quote, a later marker (history it quotes in turn) starts a quote in it
    const children = nodesOf(list.slice(start), tag, cx, 0);
    const quote: Element = { type: 'element', tag: 'div', attrs: F({}), style: F({}), part: 'quote', children };
    const out = [...nodesOf(list.slice(0, start), tag, cx, start), F(quote)];
    F(out);
    return out;
  }
  const out: Node[] = [];
  for (const c of list) {
    if (c.type === 'text') {
      if (allowed) continue; // whitespace between rows and cells: not rendered, and not placeable
      const last = out[out.length - 1];
      if (last?.type === 'text') out[out.length - 1] = { type: 'text', value: last.value + c.value };
      else if (c.value) out.push({ type: 'text', value: c.value });
      continue;
    }
    const n = element(c, cx);
    if (!n) continue;
    if (allowed && !allowed.has(n.tag)) continue;
    // a table part outside its place (the parser never builds one; kept out all the same)
    if (!allowed && TAGS[n.tag].inTable) continue;
    out.push(n);
  }
  // the elements are frozen by element(); text nodes once merged
  for (let i = 0; i < out.length; i++) if (out[i]!.type === 'text') F(out[i]);
  F(out);
  return out;
}

function element(el: RawElement, cx: Context): Element | null {
  const known = TAG_OF.get(el.tag);
  if (known === null) return null;
  const tag: Tag = known ?? (el.tag in TAGS ? (el.tag as Tag) : 'span');
  const info = TAGS[tag];
  const attrs: Attrs = {};
  // most elements have no attribute the tag keeps (a cell's style, class, align and width are the cascade's):
  // the kept ones are read in their order only when one is there
  const allowed = ALLOWED.get(tag);
  let some = !allowed;
  for (let i = 0; !some && i < el.attrs.length; i++) some = allowed!.has(el.attrs[i][0]);
  if (some) {
    for (const name of ATTRS[tag]) {
      const raw = attr(el, name);
      if (raw === null) continue;
      const v = attribute(tag, name, raw, cx);
      if (v !== null) attrs[name] = v;
    }
  }
  // an old-style anchor, <a name="top">, is a target as an id is
  if (tag === 'a' && attrs.id === undefined) {
    const name = attr(el, 'name');
    if (name !== null && cx.targets.has(name) && !cx.ids.has(name)) {
      cx.ids.add(name);
      attrs.id = name;
    }
  }
  const style = projected(cx.styles.get(el), tag, cx);
  if (tag === 'img') {
    // a pixel shows nothing; what it is for is telling the sender the email was opened
    if (pixel(style)) return null;
    image(el, attrs, cx);
  }
  const out: Element = { type: 'element', tag, attrs: F(attrs), style, children: info.void ? NO_CHILDREN() : nodes(el, tag, cx) };
  const part = partOf(el, tag);
  if (part) {
    out.part = part;
    if (part === 'quote') cx.quoted = true;
  }
  return F(out);
}

// ── Quoted history and signatures ─────────────────────────────────────────────────────────────────────
// What mail clients write around the history a reply quotes and around a signature, by class, id or type: the
// element is the part. Only on div and blockquote, the tags that carry a part (the components' PARTS).

const QUOTE_CLASSES = ['gmail_quote', 'yahoo_quoted', 'protonmail_quote', 'moz-cite-prefix'];
const SIGNATURE_CLASSES = ['gmail_signature', 'moz-signature'];
const NO_CLASSES: readonly string[] = [];

function partOf(el: RawElement, tag: Tag): Element['part'] | undefined {
  if (tag !== 'div' && tag !== 'blockquote') return undefined;
  const cls = attr(el, 'class');
  const classes = cls === null ? NO_CLASSES : cls.split(/\s+/);
  const id = attr(el, 'id');
  // Gmail, Yahoo, Proton, Thunderbird's "On … wrote:", new Outlook; Apple Mail's and Thunderbird's quote
  if (QUOTE_CLASSES.some((c) => classes.includes(c)) || id === 'mail-editor-reference-message-container') return 'quote';
  if (tag === 'blockquote' && attr(el, 'type')?.trim().toLowerCase() === 'cite') return 'quote';
  // Gmail, Thunderbird, Outlook on the web and on phones
  if (SIGNATURE_CLASSES.some((c) => classes.includes(c)) || attr(el, 'data-smartmail') === 'gmail_signature'
    || id === 'Signature' || id === 'ms-outlook-mobile-signature') return 'signature';
  return undefined;
}

/** the header block Outlook for Windows writes above the history it quotes (From:, Sent:, in the reader's language) */
const OUTLOOK_HEADER = /^\s*border:\s*none;\s*border-top:\s*solid\s+#(?:e1e1e1|b5c4df)\s+1(?:\.0)?pt;?\s*padding:\s*3(?:\.0)?pt\s+0(?:cm|in)?\s+0(?:cm|in)?\s+0(?:cm|in)?/i;

/**
 * Where Outlook's quoted history starts: its marker (Outlook on the web's `appendonsend` or `divRplyFwdMsg`, Outlook
 * for Windows' header block), or an element that holds one as its only content (Outlook wraps its header in a div):
 * the elements from `el` to the marker, or null. A marker of a quote already started is none.
 */
function startsRest(el: RawElement, cx: Context, depth: number): RawElement[] | null {
  if (cx.started.has(el)) return null;
  if (isMarker(el.tag, attr(el, 'id'), el.tag === 'div' ? attr(el, 'style') : null)) return [el];
  if (depth >= 3) return null;
  // its only content: one element, and no other element or text but whitespace
  let only: RawNode | null = null;
  for (const c of el.children) {
    if (c.type === 'text' && !c.value.trim()) continue;
    if (only) return null;
    only = c;
  }
  const inner = only?.type === 'element' ? startsRest(only, cx, depth + 1) : null;
  return inner && [el, ...inner];
}

/** whether an element with this tag, id and style attribute is one of Outlook's markers */
function isMarker(tag: string, id: string | null, style: string | null): boolean {
  return id === 'appendonsend' || id === 'divRplyFwdMsg' || (tag === 'div' && style !== null && OUTLOOK_START.test(style) && OUTLOOK_HEADER.test(style));
}

// how OUTLOOK_HEADER starts, without the `i` flag: a case-insensitive pattern costs a tenth of a millisecond to
// compile, on the first email opened, and most styles are not this one
const OUTLOOK_START = /^\s*[bB][oO][rR][dD][eE][rR]:/;

/**
 * What becomes of each tag sinter/tags.ts names, in one lookup: null when it is dropped, else the tree's tag (itself, or
 * what it is renamed to); dropping first, then keeping, then renaming, as element() reads them. Any other is a span.
 */
const TAG_OF = new Map<string, Tag | null>([
  ...Object.entries(RENAME),
  ...Object.keys(TAGS).map((t) => [t, t as Tag] as const),
  ...[...DROP].map((t) => [t, null] as const),
]);

/** each tag's attributes, GLOBAL included (attrsOf), listed once */
const ATTRS = Object.fromEntries(Object.keys(TAGS).map((t) => [t, attrsOf(t as Tag)])) as Record<Tag, readonly (keyof Attrs)[]>;
const ALLOWED = new Map<string, ReadonlySet<string>>(Object.entries(ATTRS).map(([t, names]) => [t, new Set(names)]));

/**
 * The resolved style with only the properties `tag` binds. The cascade shares one resolved style among the
 * elements that have the same, so this shares one result per resolved style and tag, as one object of the tree.
 */
function projected(resolved: Style | undefined, tag: Tag, cx: Context): Style {
  if (!resolved) return F({});
  let byTag = cx.projected.get(resolved);
  if (!byTag) cx.projected.set(resolved, (byTag = new Map()));
  let style = byTag.get(tag);
  if (!style) {
    style = {};
    const binds = BINDS.get(tag);
    // a resolved style has a few of the properties, in PROPERTIES order (sinter/css, finish): when the tag's
    // are in that order too, its own are gone through, not every one the tag binds
    if (binds) { for (const p in resolved) if (binds.has(p as Property)) style[p as Property] = resolved[p as Property]; }
    else for (const p of TAGS[tag].props) if (resolved[p] !== undefined) style[p] = resolved[p];
    byTag.set(tag, F(style));
  }
  return style;
}

/** the properties each tag binds whose list is in PROPERTIES order (most tags': FLOW and the groups after it) */
const BINDS = new Map<string, ReadonlySet<Property>>();
for (const [tag, info] of Object.entries(TAGS)) {
  const at = info.props.map((p) => PROPERTIES.indexOf(p));
  if (at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1]!))) BINDS.set(tag, new Set(info.props));
}

const INTEGER = /^\s*\d{1,9}\s*$/;
const LENGTH = /^\s*\d{1,5}\s*%?\s*$/;
const KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  dir: ['ltr', 'rtl', 'auto'],
  scope: ['row', 'col', 'rowgroup', 'colgroup'],
};

/** an attribute's value as the tree keeps it, or null to leave it out */
function attribute(tag: Tag, name: keyof Attrs, value: string, cx: Context): string | null {
  switch (name) {
    case 'href': {
      const v = value.trim();
      if (v.startsWith('#')) {
        const f = fragment(v);
        return f && cx.targets.has(f) ? '#mail-' + encodeURIComponent(f) : null;
      }
      const u = absolute(v, ['http:', 'https:', 'mailto:', 'tel:']);
      return u ? u.href : null;
    }
    case 'cite': {
      const u = absolute(value.trim(), ['http:', 'https:']);
      return u ? u.href : null;
    }
    case 'src':
      return null; // images: image()
    case 'id': {
      const v = value;
      if (!v || !cx.targets.has(v) || cx.ids.has(v)) return null;
      cx.ids.add(v);
      return v;
    }
    case 'width':
    case 'height':
      return LENGTH.test(value) ? value.replace(/\s/g, '') : null;
    case 'colspan':
      return INTEGER.test(value) ? String(Math.min(Math.max(+value, 1), 1000)) : null;
    case 'rowspan':
      return INTEGER.test(value) ? String(Math.min(+value, 65534)) : null;
    case 'span':
      return INTEGER.test(value) ? String(Math.min(Math.max(+value, 1), 1000)) : null;
    case 'start':
    case 'value':
      return /^\s*-?\d{1,9}\s*$/.test(value) ? String(+value) : null;
    case 'reversed':
    case 'open':
      return '';
    case 'type':
      return tag === 'ol' ? (['1', 'a', 'A', 'i', 'I'].includes(value.trim()) ? value.trim() : null)
        : ['disc', 'circle', 'square'].includes(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null;
    case 'role': {
      // ARIA's list of roles, the first one the browser knows taken: only the ones that say a table is for layout
      const v = value.trim().toLowerCase().split(/\s+/)[0]!;
      return v === 'presentation' || v === 'none' ? v : null;
    }
    case 'dir':
    case 'scope': {
      const v = value.trim().toLowerCase();
      return KEYWORDS[name].includes(v) ? v : null;
    }
    case 'lang':
      return /^[a-z\d-]{1,35}$/i.test(value.trim()) ? value.trim() : null;
    default:
      // text: title, alt, abbr, headers, datetime; bounded, as no email needs a longer one
      return value.length > 2000 ? value.slice(0, 2000) : value;
  }
}

/**
 * An image whose box is at most 1 × 1 pixel (its `width` and `height`, as attributes or CSS, both known): a
 * tracking pixel or a spacer that takes no room. It is left out, so it never loads and its origin is not listed.
 */
function pixel(style: Style): boolean {
  return small(style.width) && small(style.height);
}

const small = (v: string | undefined) => v !== undefined && PX.test(v) && parseFloat(v) <= 1;
const PX = /^(?:0|\d*\.?\d+px)$/;

/** an image's `src` under the options, and its origin counted */
function image(el: RawElement, attrs: Attrs, cx: Context): void {
  const src = (attr(el, 'src') ?? '').trim();
  const { o } = cx;
  if (/^cid:/i.test(src)) {
    const id = contentId(src.slice(4));
    const url = o.cidMap.get(id) ?? (o.cidTemplate ? o.cidTemplate.replace('{cid}', encodeURIComponent(id)) : undefined);
    if (url !== undefined && appUrl(url)) attrs.src = url;
    return;
  }
  if (/^data:/i.test(src)) {
    const v = src.replace(/\s/g, '');
    if (RASTER.test(v) && v.length <= o.dataImages) attrs.src = v;
    return;
  }
  const u = absolute(src, ['http:', 'https:']);
  if (!u) return;
  cx.origins.add(u.origin);
  if (o.images === 'allow') attrs.src = u.href;
  else if (o.images === 'proxy') attrs.src = o.proxy.replace('{url}', encodeURIComponent(u.href));
}

export type { RawNode };
