// The HTML parser: an email's HTML as the raw tree of sinter/raw.ts, the document the browser builds from it
// (the standard's tokenizer and tree construction, tokenizer.ts and tree.ts), without its comments, doctype,
// foreign content (`<svg>`, `<math>`, dropped with their subtrees) and template contents.
//
// Pure and self-contained: it imports nothing outside this folder and uses no global beyond the language's,
// so sinter can run it at build time and in the browser alike.
import type { RawElement, RawNode } from '../raw.js';
import { build, HTML, type Node } from './tree.js';

export interface ParseHTMLOptions {
  /**
   * The deepest an element may be nested, the `<html>` element being 1 (default 256). An element that would
   * open deeper goes beside the element at the bound instead of inside it, as browsers bound their trees,
   * so a hostile email can neither build a tree deeper than this nor make the parse slower than linear.
   */
  maxDepth?: number;
}

/** `html` parsed as the browser parses it: its `<html>` element */
export function parseHTML(html: string, options?: ParseHTMLOptions): RawElement {
  const max = Math.max(3, Math.floor(options?.maxDepth ?? 256));
  return toRaw(build(String(html), max), max);
}

/** the parse's tree as raw nodes: foreign elements and template contents left out, adjacent texts joined */
function toRaw(root: Node, max: number): RawElement {
  const out: RawElement = { type: 'element', tag: root.tag, attrs: root.attrs, children: [], parent: null };
  // three stacks side by side, not a tuple per node
  const ns: (Node | string)[] = [], intos: RawElement[] = [], depths: number[] = [];
  const add = (n: Node, into: RawElement, depth: number): void => {
    const kids = n.kids;
    for (let i = kids.length - 1; i >= 0; i--) { ns.push(kids[i]); intos.push(into); depths.push(depth); }
  };
  add(root, out, 1);
  while (ns.length) {
    const n = ns.pop()!, into = intos.pop()!, depth = depths.pop()!;
    if (typeof n === 'string') {
      const last = into.children[into.children.length - 1];
      if (last !== undefined && last.type === 'text') last.value += n;
      else into.children.push({ type: 'text', value: n });
    } else if (n.ns === HTML) {
      if (depth >= max) {
        add(n, into, depth);
        continue;
      }
      // the parser's own list: nothing reads the parse's tree after this
      const el: RawElement = { type: 'element', tag: n.tag, attrs: n.attrs, children: [], parent: into };
      into.children.push(el as RawNode);
      add(n, el, depth + 1);
    }
  }
  return out;
}
