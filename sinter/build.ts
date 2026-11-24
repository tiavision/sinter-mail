// The tree of mail.parse as elements, created directly (<mail-view>'s script, components/internal/mail-view.ts).
//
// What it may write is what the generated components may write, from the same table (tags.ts): an element whose tag
// is a key of TAGS (createElement with a name from the table, never from the tree), the attributes attrsOf(tag) names
// (a URL attribute only with an allowed scheme: sinter's attrAllowed), the properties TAGS[tag].props names (style.setProperty, never a
// style attribute; no value that could load a URL), text as text nodes. No markup is parsed.
import { attrAllowed, styleAllowed } from '@tiaforge-ui/sinter';
import { attrsOf, TAGS } from './tags.js';
import type { Body, Element as El, Node as TreeNode, Tag } from './sinter.types.js';

const has = Object.prototype.hasOwnProperty;
const shown = (n: TreeNode): n is El => n.type === 'element' && n.style.display !== 'none';

/** per tag: its attributes (as a lookup with no prototype: a key of the tree is data), and each of its properties' place in its component's order */
const ATTRS = {} as Record<Tag, Record<string, true>>, ORDER = {} as Record<Tag, Record<string, number>>;
for (const t of Object.keys(TAGS) as Tag[]) {
  const a: Record<string, true> = Object.create(null);
  for (const k of attrsOf(t)) a[k] = true;
  ATTRS[t] = a;
  const o: Record<string, number> = Object.create(null);
  TAGS[t].props.forEach((p, i) => { o[p] = i + 1; });
  ORDER[t] = o;
}

/**
 * Emails repeat their styles: per style and tag, once it is seen a second time, an element with that style and no
 * attributes, which the next ones are copies of (cloneNode skips the property parsing that setProperty does), so a
 * style seen once costs nothing more. By style object (mail.parse shares one among elements with the same style),
 * and by content within one build, for a tree from JSON, which has an object per element.
 */
const protosOf = new WeakMap<Document, WeakMap<object, Map<Tag, HTMLElement | null>>>();
/** in the current build: the document its elements are made in, and its prototypes (never another document's: a
 * clone is of its prototype's document, and an image in the page's document loads) */
let doc: Document, protos: WeakMap<object, Map<Tag, HTMLElement | null>>;
/** in the current build: the first style object with each content */
let byText = new Map<string, object>();
function styled(n: El, tag: Tag): HTMLElement {
  let m = protos.get(n.style);
  if (!m) {
    let k = '';
    const s = n.style as Record<string, unknown>;
    for (const p in s) k += p + ':' + s[p] + ';';
    const first = byText.get(k);
    if (first) m = protos.get(first)!;
    else { byText.set(k, n.style); m = new Map(); }
    protos.set(n.style, m);
  }
  const p = m.get(tag);
  if (p) return p.cloneNode(false) as HTMLElement;
  if (p === null) { const q = fresh(n, tag); m.set(tag, q); return q.cloneNode(false) as HTMLElement; }
  m.set(tag, null);
  return fresh(n, tag);
}
/** a new element of `tag` with `n`'s style */
function fresh(n: El, tag: Tag): HTMLElement {
  const e = doc.createElement(tag);
  if (tag === 'a') { e.setAttribute('target', '_blank'); e.setAttribute('rel', 'noopener noreferrer'); }
  // the properties the tag binds, in its component's order: the tree's own order when that is the same (parse.ts
  // writes them so), else the table's
  const s = n.style as Record<string, unknown>, st = e.style, order = ORDER[tag];
  let at = 0, sorted = true;
  for (const p in s) { const i = order[p]; if (i !== undefined) { if (i < at) { sorted = false; break; } at = i; } }
  if (sorted) { for (const p in s) if (order[p] !== undefined) put(st, p, s[p]); }
  else for (const p of TAGS[tag].props) put(st, p, s[p]);
  return e;
}

/** the element of `n` as `tag` (a key of TAGS): its attributes, its style, its parts */
function open(n: El, tag: Tag): HTMLElement {
  const e = styled(n, tag);
  // the attributes it has that the tag may have (an element has two or three of its tag's dozen)
  const a = n.attrs as Record<string, unknown>, allowed = ATTRS[tag];
  for (const k in a) {
    if (allowed[k] !== true || !has.call(a, k)) continue;
    let v = a[k];
    if (v == null || v === false || (k === 'id' && !v)) continue;
    v = v === true ? '' : k === 'id' ? 'mail-' + v : '' + v;
    // as data-sn-attr writes it: a URL attribute only with an allowed scheme (the app's `urlSchemes` included)
    if (attrAllowed(e, k, v as string)) e.setAttribute(k, v as string);
  }
  if (tag === 'blockquote' || tag === 'div') { if (n.part === 'quote') e.className = 'mail-quote'; else if (n.part === 'signature') e.className = 'mail-signature'; }
  return e;
}
const put = (st: CSSStyleDeclaration, p: string, v: unknown) => {
  if (v != null && v !== false && styleAllowed(v as string)) st.setProperty(p, v as string);
};
/** the children of `n` into `e`: text runs, every shown element by its tag */
function flow(n: { children: TreeNode[] }, e: Node): void {
  const list = n.children;
  // text alone, as most cells, paragraphs and links hold: one call for its node
  if (list.length === 1 && list[0]!.type === 'text') { e.textContent = list[0]!.value; return; }
  for (const c of list) {
    if (c.type === 'text') e.appendChild(doc.createTextNode(c.value));
    else if (c.style.display !== 'none') node(c, e);
  }
}
function node(n: El, parent: Node): void {
  const tag = n.tag;
  if (!has.call(TAGS, tag)) return;
  const info = TAGS[tag];
  // a table's part outside a table: its content
  if (info.inTable) { const e = doc.createElement('span'); flow(n, e); parent.appendChild(e); return; }
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

/** the children of `b` as a fragment, of `into` (the page's document by default) */
export function build(b: Body, into: Document = document): DocumentFragment {
  doc = into;
  protos = protosOf.get(into) ?? new WeakMap();
  protosOf.set(into, protos);
  const f = into.createDocumentFragment();
  try { flow(b, f); } finally { byText = new Map(); }
  return f;
}
