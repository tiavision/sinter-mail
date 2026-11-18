// The reference parse: parse5 (the HTML standard's tree construction, as browsers run it), converted to the
// raw tree of sinter/raw.ts. The parser's tests compare sinter/parser with it; the cascade's tests build
// their input with it.
import { parse } from 'parse5';
import type { RawElement, RawNode } from '../sinter/raw.js';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

interface P5Node {
  nodeName: string;
  tagName?: string;
  namespaceURI?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5Node[];
  value?: string;
}

/** `html` parsed by parse5, as a raw tree rooted at its `<html>` element */
export function reference(html: string): RawElement {
  const doc = parse(html) as unknown as P5Node;
  const root = doc.childNodes!.find((n) => n.tagName === 'html')!;
  return convert(root, null) as RawElement;
}

function convert(n: P5Node, parent: RawElement | null): RawNode | null {
  if (n.nodeName === '#text') return { type: 'text', value: n.value! };
  if (!n.tagName) return null; // comments, doctypes
  if (n.namespaceURI !== HTML_NS) return null; // foreign content: dropped with its subtree
  const el: RawElement = { type: 'element', tag: n.tagName, attrs: n.attrs!.map((a) => [a.name, a.value]), children: [], parent };
  // <template>'s content is a fragment of its own (not children); the raw tree keeps the element empty
  for (const c of n.childNodes ?? []) {
    const r = convert(c, el);
    if (!r) continue;
    const last = el.children[el.children.length - 1];
    // a comment between two texts leaves two text nodes in the DOM; the raw tree has no comments, so it joins them
    if (r.type === 'text' && last?.type === 'text') last.value += r.value;
    else el.children.push(r);
  }
  return el;
}

/** a raw tree as a plain structure without parents, for `toEqual` */
export function plainOf(n: RawNode): unknown {
  return n.type === 'text' ? n.value : [n.tag, Object.fromEntries(n.attrs), ...n.children.map(plainOf)];
}
