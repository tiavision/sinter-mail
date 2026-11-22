// SPIKE: the tree of mail.parse as elements, created directly (<mail-view>'s script, mail-view.ts).
//
// What it may write is what the generated components may write, from the same table (tags.ts): an element whose tag
// is a key of TAGS (createElement with a name from the table, never from the tree), the attributes attrsOf(tag) names
// (a URL attribute only with an allowed scheme), the properties TAGS[tag].props names (style.setProperty, never a
// style attribute; no value that could load a URL), text as text nodes. No markup is parsed.
import { attrsOf, TAGS } from './tags.js';
import type { Body, Element as El, Node as TreeNode, Tag } from './sinter.types.js';

const has = Object.prototype.hasOwnProperty;
const URL_ATTR = /^(href|src|cite)$/;
const STYLE_BAD = /url\(|image(-set)?\(|\\/i;
const schemeOf = (value: string): string | null => {
  const m = /^[\0- ]*([a-z][a-z\d+.-]*):/i.exec(value.replace(/[\t\n\r]/g, ''));
  return m ? m[1]!.toLowerCase() + ':' : null;
};
const SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);
let base: string | null = null;
function urlOk(tag: string, name: string, v: string): boolean {
  const p = schemeOf(v) ?? (base ??= schemeOf(document.baseURI));
  return !!p && (SCHEMES.has(p) || ((p === 'data:' || p === 'blob:') && name === 'src' && tag === 'img'));
}
const shown = (n: TreeNode): n is El => n.type === 'element' && n.style.display !== 'none';

/** per tag: its attributes, and each of its properties' place in its component's order */
const ATTRS = {} as Record<Tag, readonly string[]>, ORDER = {} as Record<Tag, Record<string, number>>;
for (const t of Object.keys(TAGS) as Tag[]) {
  ATTRS[t] = attrsOf(t);
  const o: Record<string, number> = Object.create(null);
  TAGS[t].props.forEach((p, i) => { o[p] = i + 1; });
  ORDER[t] = o;
}

/** the element of `n` as `tag` (a key of TAGS): its attributes, its style, its parts */
function open(n: El, tag: Tag): HTMLElement {
  const e = document.createElement(tag);
  if (tag === 'a') { e.setAttribute('target', '_blank'); e.setAttribute('rel', 'noopener noreferrer'); }
  const a = n.attrs as Record<string, unknown>;
  for (const k of ATTRS[tag]) {
    let v = a[k];
    if (v == null || v === false || (k === 'id' && !v)) continue;
    v = v === true ? '' : k === 'id' ? 'mail-' + v : '' + v;
    if (!URL_ATTR.test(k) || urlOk(tag, k, v as string)) e.setAttribute(k, v as string);
  }
  // the properties the tag binds, in its component's order: the tree's own order when that is the same (parse.ts
  // writes them so), else the table's
  const s = n.style as Record<string, unknown>, st = e.style, order = ORDER[tag];
  let at = 0, sorted = true;
  for (const p in s) { const i = order[p]; if (i !== undefined) { if (i < at) { sorted = false; break; } at = i; } }
  if (sorted) { for (const p in s) if (order[p] !== undefined) put(st, p, s[p]); }
  else for (const p of TAGS[tag].props) put(st, p, s[p]);
  if (tag === 'blockquote' || tag === 'div') { if (n.part === 'quote') e.className = 'mail-quote'; else if (n.part === 'signature') e.className = 'mail-signature'; }
  return e;
}
const put = (st: CSSStyleDeclaration, p: string, v: unknown) => {
  if (v != null && v !== false && !STYLE_BAD.test(v as string)) st.setProperty(p, v as string);
};
/** the children of `n` into `e`: text runs, every shown element by its tag */
function flow(n: { children: TreeNode[] }, e: Node): void {
  for (const c of n.children) {
    if (c.type === 'text') e.appendChild(document.createTextNode(c.value));
    else if (c.style.display !== 'none') node(c, e);
  }
}
function node(n: El, parent: Node): void {
  const tag = n.tag;
  if (!has.call(TAGS, tag)) return;
  const info = TAGS[tag];
  // a table's part outside a table: its content
  if (info.inTable) { const e = document.createElement('span'); flow(n, e); parent.appendChild(e); return; }
  const e = open(n, tag);
  if (tag === 'table') table(n, e);
  else if (!info.void) flow(n, e);
  parent.appendChild(e);
}
/** a table's structure, as mail-table writes it: caption, colgroup and its cols, the sections, rows and cells */
function table(n: El, e: HTMLElement): void {
  for (const s of n.children) {
    if (s.type !== 'element') continue;
    if (shown(s) && s.tag === 'caption') { const c = open(s, 'caption'); flow(s, c); e.appendChild(c); }
    else if (s.tag === 'colgroup') {
      const g = open(s, 'colgroup');
      for (const k of s.children) if (k.type === 'element') g.appendChild(open(k, 'col'));
      e.appendChild(g);
    } else if (shown(s)) {
      const sec = open(s, s.tag === 'thead' || s.tag === 'tfoot' ? s.tag : 'tbody');
      for (const r of s.children) {
        if (!shown(r)) continue;
        const tr = open(r, 'tr');
        for (const d of r.children) if (shown(d)) { const c = open(d, d.tag === 'th' ? 'th' : 'td'); flow(d, c); tr.appendChild(c); }
        sec.appendChild(tr);
      }
      e.appendChild(sec);
    }
  }
}

/** the children of `b` as a fragment */
export function build(b: Body): DocumentFragment {
  const f = document.createDocumentFragment();
  flow(b, f);
  return f;
}
