// The raw tree: what the HTML parser (sinter/parser) builds and the cascade (sinter/css) reads, before
// parse.ts keeps only what an email may contain. It is the document the browser would build from the same
// HTML: every element, with its attributes as written (names lowercase), and its text. Comments, doctypes
// and processing instructions are not in it; neither is foreign content (`<svg>`, `<math>`), which is
// dropped with its subtree. `<style>` elements are in the tree with their text as one Text child.

export interface RawText {
  type: 'text';
  value: string;
}

export interface RawElement {
  type: 'element';
  /** lowercase, as the browser's `localName` */
  tag: string;
  /** in source order, names lowercase, the first of duplicate names kept (as the browser does) */
  attrs: [name: string, value: string][];
  children: RawNode[];
  parent: RawElement | null;
}

export type RawNode = RawElement | RawText;

/** an attribute's value, or null */
export function attr(el: RawElement, name: string): string | null {
  const a = el.attrs;
  for (let i = 0; i < a.length; i++) if (a[i][0] === name) return a[i][1];
  return null;
}
