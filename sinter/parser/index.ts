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
  const out: RawElement = { type: 'element', tag: root.tag, attrs: copy(root), children: [], parent: null };
  // depth first without recursion (a tree can be as deep as `max`); each entry a node, its parent and the parent's depth
  const todo: [Node | string, RawElement, number][] = [];
  const add = (n: Node, into: RawElement, depth: number): void => {
    for (let i = n.kids.length - 1; i >= 0; i--) todo.push([n.kids[i], into, depth]);
  };
  add(root, out, 1);
  while (todo.length) {
    const [n, into, depth] = todo.pop()!;
    if (typeof n === 'string') {
      const last = into.children[into.children.length - 1];
      if (last?.type === 'text') last.value += n;
      else into.children.push({ type: 'text', value: n });
    } else if (n.ns === HTML) {
      if (depth >= max) {
        // deeper than the bound, which only the adoption agency's moves can make: its content goes in its place
        add(n, into, depth);
        continue;
      }
      const el: RawElement = { type: 'element', tag: n.tag, attrs: copy(n), children: [], parent: into };
      into.children.push(el as RawNode);
      add(n, el, depth + 1);
    }
  }
  return out;
}

const copy = (n: Node): [string, string][] => n.attrs.map(([a, v]) => [a, v]);
