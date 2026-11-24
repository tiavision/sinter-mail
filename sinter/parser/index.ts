// The HTML parser: an email's HTML as the raw tree of sinter/raw.ts, the document the browser builds from it
// (the standard's tokenizer and tree construction, tokenizer.ts and tree.ts), without its comments, doctype,
// foreign content (`<svg>`, `<math>`, dropped with their subtrees) and template contents.
//
// Pure and self-contained: it imports nothing outside this folder and uses no global beyond the language's,
// so sinter can run it at build time and in the browser alike.
import type { RawElement, RawNode } from '../raw.js';
import { build } from './tree.js';

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
  const { root, deep } = build(String(html), max);
  if (deep) bound(root, max);
  return root;
}

/**
 * The tree construction keeps the stack of open elements within the bound, but the adoption agency can move
 * elements below it: an element deeper than `max` is left out, and its text goes into its ancestor at the
 * bound (`max - 1` below the `<html>` element), joined with the text there.
 */
function bound(root: RawElement, max: number): void {
  // two stacks side by side, not a tuple per element
  const els: RawElement[] = [root], depths: number[] = [0];
  while (els.length) {
    const el = els.pop()!, depth = depths.pop()!, kids = el.children;
    if (depth < max - 1) {
      for (const k of kids) if (k.type === 'element') { els.push(k); depths.push(depth + 1); }
      continue;
    }
    if (!kids.some((k) => k.type === 'element')) continue;
    // its text and its descendants', in order
    let text = '';
    const rest: RawNode[] = kids.slice().reverse();
    while (rest.length) {
      const n = rest.pop()!;
      if (n.type === 'text') text += n.value;
      else for (let i = n.children.length - 1; i >= 0; i--) rest.push(n.children[i]);
    }
    el.children = text ? [{ type: 'text', value: text }] : [];
  }
}
