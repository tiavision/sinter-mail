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
import { parseHTML, resolveStyles } from '@tiaforge-ui/sinter-mail/parser';
import { memo } from '@tiaforge-ui/sinter/memo';
import type { RawElement, RawNode } from './raw.js';
import { attr } from './raw.js';
import { attrsOf, DROP, RENAME, TAGS, TEXT } from './tags.js';
import type { Attrs, Body, Element, Node, ParseOptions, Property, Style, Tag } from './sinter.types.js';

/**
 * The tree of an email's HTML body under `options`. The same source and options give the same tree,
 * frozen: change a copy.
 */
export function parse(html: string | null | undefined, options?: ParseOptions): Body {
  const o = optionsOf(options);
  return parseTree(typeof html === 'string' ? html : '', o.images, o.proxy, o.cidTemplate, o.cidMap, o.media, o.dataImages);
}

/** the parse, kept by its arguments (all primitives, or an array of them: memo's keys) */
const parseTree = memo(
  (html: string, images: Images, proxy: string, cidTemplate: string, cidMap: string[], media: 'wide' | 'narrow', dataImages: number): Body =>
    build(html, { images, proxy, cidTemplate, cidMap: pairs(cidMap), media, dataImages }),
  { maxSize: 8 * 1024 * 1024 },
);

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
}

function build(html: string, o: Options): Body {
  const root = parseHTML(html);
  const styles = resolveStyles(root, { media: o.media });
  const body = root.children.find((n): n is RawElement => n.type === 'element' && n.tag === 'body');
  const cx: Context = { o, targets: new Set(), ids: new Set(), origins: new Set(), styles, projected: new Map() };
  if (body) collectTargets(body, cx.targets);
  const children = body ? nodes(body, 'body', cx) : [];
  // the body's style is the root's: its text properties and its background, the <html> element's under it
  const style: Style = {};
  for (const el of [root, body]) {
    const s = el && styles.get(el);
    if (!s) continue;
    for (const p of ROOT_PROPS) if (s[p] !== undefined) style[p] = s[p];
  }
  return { type: 'body', style, children, images: { origins: [...cx.origins].sort() } };
}

const ROOT_PROPS: readonly Property[] = [...TEXT, 'background-color'];

/**
 * The fragments in-email links point at that the email has (an id, or an old-style `<a name>`): such a
 * link keeps its href, and its target its id. Every other id is left out, and every other fragment link
 * loses its href.
 */
function collectTargets(body: RawElement, out: Set<string>): void {
  const linked = new Set<string>(), named = new Set<string>();
  const stack: RawElement[] = [body];
  while (stack.length) {
    const el = stack.pop()!;
    const id = attr(el, 'id');
    if (id) named.add(id);
    if (el.tag === 'a') {
      const name = attr(el, 'name');
      if (name) named.add(name);
      const href = attr(el, 'href')?.trim();
      if (href?.startsWith('#') && href.length > 1) linked.add(fragment(href));
    }
    for (const c of el.children) if (c.type === 'element') stack.push(c);
  }
  for (const f of linked) if (named.has(f)) out.add(f);
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
  const allowed = TABLE_CHILDREN[tag];
  const out: Node[] = [];
  for (const c of el.children) {
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
  return out;
}

function element(el: RawElement, cx: Context): Element | null {
  if (DROP.has(el.tag)) return null;
  const tag: Tag = el.tag in TAGS ? (el.tag as Tag) : RENAME[el.tag] ?? 'span';
  const info = TAGS[tag];
  const attrs: Attrs = {};
  for (const name of ATTRS[tag]) {
    const raw = attr(el, name);
    if (raw === null) continue;
    const v = attribute(tag, name, raw, cx);
    if (v !== null) attrs[name] = v;
  }
  // an old-style anchor, <a name="top">, is a target as an id is
  if (tag === 'a' && attrs.id === undefined) {
    const name = attr(el, 'name');
    if (name !== null && cx.targets.has(name) && !cx.ids.has(name)) {
      cx.ids.add(name);
      attrs.id = name;
    }
  }
  if (tag === 'img') image(el, attrs, cx);
  const style = projected(cx.styles.get(el), tag, cx);
  return { type: 'element', tag, attrs, style, children: info.void ? [] : nodes(el, tag, cx) };
}

/** each tag's attributes, GLOBAL included (attrsOf), listed once */
const ATTRS = Object.fromEntries(Object.keys(TAGS).map((t) => [t, attrsOf(t as Tag)])) as Record<Tag, readonly (keyof Attrs)[]>;

/**
 * The resolved style with only the properties `tag` binds. The cascade shares one resolved style among the
 * elements that have the same, so this shares one result per resolved style and tag, as one object of the tree.
 */
function projected(resolved: Style | undefined, tag: Tag, cx: Context): Style {
  if (!resolved) return {};
  let byTag = cx.projected.get(resolved);
  if (!byTag) cx.projected.set(resolved, (byTag = new Map()));
  let style = byTag.get(tag);
  if (!style) {
    style = {};
    for (const p of TAGS[tag].props) if (resolved[p] !== undefined) style[p] = resolved[p];
    byTag.set(tag, style);
  }
  return style;
}

const INTEGER = /^\s*\d{1,9}\s*$/;
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
      return /^\s*\d{1,5}\s*%?\s*$/.test(value) ? value.replace(/\s/g, '') : null;
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
