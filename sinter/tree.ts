// Helpers that read a body's tree: `mail.text` (a preview, a search snippet) and `mail.links` (an app that lists
// or checks a message's links). This module does not import the parser, so these stay ordinary helpers when an
// app makes the package lazy: they render early and fold at build time. Pure functions of their arguments, with
// no globals beyond the language's and no recursion: a deep tree does not overflow the stack. No cache (a walk is
// cheap next to a parse), but in mail.unquoted, whose copy must be the same object for the same tree.
import type { Body, Element, LinkInfo, Node, Tag } from './sinter.types.js';

/** how an element lays out its text: on the line, as a block, a table row or cell, or not at all */
type Kind = 'inline' | 'block' | 'row' | 'cell' | 'none';

const INLINE = new Set<Tag>([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'del', 'dfn', 'em', 'font', 'i', 'img', 'ins', 'kbd', 'mark',
  'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr',
]);
/** blocks set apart by a blank line, as a reader sees paragraphs (innerText does it for `p`) */
const PARAGRAPH = new Set<Tag>(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'dl', 'table', 'figure']);

/** the element's kind: its resolved `display` first (an email's `display: none` preheader is not shown), then its tag's */
function kindOf(el: Element): Kind {
  const d = el.style.display;
  if (d) {
    if (d === 'none') return 'none';
    if (d.startsWith('inline') || d === 'contents') return 'inline';
    if (d === 'table-row') return 'row';
    if (d === 'table-cell') return 'cell';
    return 'block';
  }
  if (INLINE.has(el.tag)) return 'inline';
  if (el.tag === 'tr') return 'row';
  if (el.tag === 'td' || el.tag === 'th') return 'cell';
  if (el.tag === 'col' || el.tag === 'colgroup') return 'none';
  return 'block';
}

/** whitespace as written (`pre`, `pre-wrap`, a plain body's paragraphs), newlines only (`pre-line`), or collapsed */
type Space = 'pre' | 'line' | 'collapse';
function spaceOf(el: Element, inherited: Space): Space {
  const w = el.style['white-space'];
  if (w === 'pre' || w === 'pre-wrap' || w === 'break-spaces') return 'pre';
  if (w === 'pre-line') return 'line';
  if (w === 'normal' || w === 'nowrap') return 'collapse';
  return el.tag === 'pre' ? 'pre' : inherited;
}

/**
 * The text of a node or a body, as a reader sees it, roughly as the browser's `innerText` gives it: texts run
 * together, whitespace collapsed outside preformatted text, a newline for each `br` and between blocks, a blank
 * line between paragraphs, quotes and lists, a tab between table cells, nothing for what `display: none` hides.
 * Never more than one blank line in a row, none at the start or the end. A text node gives its value; `''` for
 * nothing.
 */
export function text(node: Node | Body | null | undefined): string {
  if (node == null) return '';
  if (node.type === 'text') return node.value;
  let out = '', breaks = 0, space = false, tab = false;
  const put = (s: string) => {
    if (out) {
      if (breaks) out += '\n'.repeat(breaks);
      else if (tab) out += '\t';
      else if (space && !out.endsWith('\n')) out += ' ';
    }
    breaks = 0; space = tab = false;
    out += s;
  };
  const write = (value: string, ws: Space) => {
    if (ws === 'pre') { if (value) put(value); return; }
    // collapsed: each run of whitespace one space (newlines kept with pre-line), none at a line's start
    const re = ws === 'line' ? /[ \t\f\r]*\n[ \t\f\r\n]*|[ \t\f\r]+/g : /[ \t\n\f\r]+/g;
    let pos = 0, m: RegExpExecArray | null;
    while ((m = re.exec(value))) {
      if (m.index > pos) put(value.slice(pos, m.index));
      if (m[0].includes('\n')) put('\n'); else space = true;
      pos = m.index + m[0].length;
    }
    if (pos < value.length) put(value.slice(pos));
  };
  type Frame = { nodes: readonly Node[]; i: number; ws: Space; after: number; cells: number };
  const root = node.type === 'element' ? node : null;
  const stack: Frame[] = [{ nodes: node.children, i: 0, ws: root ? spaceOf(root, 'collapse') : 'collapse', after: 0, cells: 0 }];
  while (stack.length) {
    const f = stack[stack.length - 1]!;
    if (f.i >= f.nodes.length) {
      stack.pop();
      if (f.after) { breaks = Math.max(breaks, f.after); space = tab = false; }
      continue;
    }
    const n = f.nodes[f.i++]!;
    if (n.type === 'text') { write(n.value, f.ws); continue; }
    if (n.tag === 'br') {
      // a line break of its own, after the breaks already due
      if (out && breaks) out += '\n'.repeat(breaks);
      breaks = 0; space = tab = false;
      out += '\n';
      continue;
    }
    const kind = kindOf(n);
    if (kind === 'none') continue;
    let after = 0;
    if (kind === 'block') after = PARAGRAPH.has(n.tag) ? 2 : 1;
    else if (kind === 'row') after = 1;
    else if (kind === 'cell' && f.cells++ && !breaks) { tab = true; space = false; }
    if (after) { breaks = Math.max(breaks, after); space = tab = false; }
    stack.push({ nodes: n.children, i: 0, ws: spaceOf(n, f.ws), after, cells: 0 });
  }
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

/** Every link of `body` (an `a` with an `href`), in document order: its href and its text (`text()`). */
export function links(body: Body | null | undefined): LinkInfo[] {
  const out: LinkInfo[] = [];
  if (!body) return out;
  const stack: Array<{ nodes: readonly Node[]; i: number }> = [{ nodes: body.children, i: 0 }];
  while (stack.length) {
    const f = stack[stack.length - 1]!;
    if (f.i >= f.nodes.length) { stack.pop(); continue; }
    const n = f.nodes[f.i++]!;
    if (n.type !== 'element') continue;
    if (n.tag === 'a' && n.attrs.href) out.push({ href: n.attrs.href, text: text(n) });
    if (n.children.length) stack.push({ nodes: n.children, i: 0 });
  }
  return out;
}

/**
 * @deprecated `body` as it is. <mail-body> renders an email from an API whole, in about the time a progressive
 * render took to show its first part, so it no longer renders in steps. Kept for one release so that pages that call
 * it keep working; remove the call.
 */
export function progressive(body: Body, _head?: number): Body {
  return body;
}

/** the copy of each tree mail.unquoted was given, the tree itself when nothing is left out */
const unquotedOf = new WeakMap<Body, Body>();

/**
 * `body` without its quoted history (the elements of `part: 'quote'`, `body.quotes`): what a reply says, for a
 * reader that shows the history only when asked, and a long thread renders that much less. A copy, `body` unchanged
 * (a frozen tree from mail.parse goes in as it is), the same one for the same tree. `body` itself when it quotes
 * nothing, or when leaving the quotes out would leave nothing to read (a message forwarded without a word of its
 * own: its content is the quote). Without recursion.
 */
export function unquoted(body: Body): Body {
  const kept = unquotedOf.get(body);
  if (kept) return kept;
  const { quotes: _, ...rest } = body;
  const out: Body = { ...rest, children: [] };
  let left = false, images = false;
  const stack: Array<{ from: readonly Node[]; to: Node[]; k: number }> = [{ from: body.children, to: out.children, k: 0 }];
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    if (top.k === top.from.length) { stack.pop(); continue; }
    const n = top.from[top.k++]!;
    if (n.type === 'text') { top.to.push(n); continue; }
    if (n.part === 'quote') { left = true; continue; }
    if (n.tag === 'img') images = true;
    const el: Element = { ...n, children: [] };
    top.to.push(el);
    stack.push({ from: n.children, to: el.children, k: 0 });
  }
  const result = left && (images || text(out) !== '') ? out : body;
  unquotedOf.set(body, result);
  return result;
}
