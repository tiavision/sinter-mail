// `mail.plain(text, options)`: a plain-text body to the tree of sinter.types.ts, the one mail.parse returns for
// HTML, so <mail-body> renders both. Paragraphs keep their lines and spacing (`white-space: pre-wrap`), `>` quotes
// become nested blockquotes, the signature after `-- ` a div, and URLs and emails links (autolink.ts, GFM's rules).
//
// This module imports no parser (nothing from sinter/parser or parse.ts), so mail.plain stays an ordinary helper
// when an app makes the package lazy: it renders early and folds at build time. Pure, with no globals beyond the
// language's, and linear in the text. As md.parse does, it keeps its trees with sinter's memo(): one tree per text
// and options, frozen and shared.
import { memo } from '@tiaforge-ui/sinter/memo';
import { autolink } from './autolink.js';
import type { Body, Element, Node, PlainOptions } from './sinter.types.js';

/** quote levels past this are read as this one, so a run of `>` cannot nest the tree without bound */
const MAX_DEPTH = 32;

/** links made in one body: a real one has a handful; past this, a hostile text's URLs and addresses stay text, so
 * the tree (an element per link) stays small */
const MAX_LINKS = 2_000;

/**
 * The tree of a plain-text body under `options` (`flowed`, `delsp`: the message's `Content-Type` parameters).
 * The same text and options give the same tree, frozen: change a copy.
 */
export function plain(text: string | null | undefined, options?: PlainOptions): Body {
  const o = options ?? {};
  // the options normalized to primitives, so equal options share one tree (delsp means nothing without flowed)
  const flowed = flag(o.flowed, 'flowed'), delsp = flowed && flag(o.delsp, 'delsp');
  return plainTree(typeof text === 'string' ? text : '', flowed, delsp);
}

function flag(v: unknown, name: string): boolean {
  if (v == null) return false;
  if (typeof v !== 'boolean') throw new TypeError(`mail.plain: \`${name}\` is true or false, not ${JSON.stringify(v)}`);
  return v;
}

/** the conversion itself, kept by its arguments (the least recently used trees go first, past 8 MiB) */
const plainTree = memo((text: string, flowed: boolean, delsp: boolean): Body => ({
  type: 'body', style: {}, children: blocks(lines(text, flowed, delsp)), images: { origins: [] },
}), { maxSize: 8 * 1024 * 1024 });

/** a logical line: its quote depth, its text without the quote marks, and whether the signature starts at it */
interface Line { depth: number; text: string; signature: boolean }

const blank = (s: string) => !/\S/.test(s);

/**
 * The text's lines, their quote marks read. Without `flowed`, a mark is `>` and an optional space (`> >` is two
 * levels). With `flowed` (RFC 3676), the depth is the count of `>` with no space between, then a space-stuffed
 * line loses its leading space, and a line ending in a space (a soft break) is joined with the next one of the
 * same depth: not across a blank line, which ends a paragraph, nor into or out of the signature separator.
 */
function lines(text: string, flowed: boolean, delsp: boolean): Line[] {
  const out: Line[] = [];
  let signed = false, soft = false;
  // the line being joined, in pieces (a long flowed paragraph is not built by repeated concatenation)
  let parts: string[] = [], last: Line | null = null;
  const end = () => { if (last) { last.text = parts.join(''); out.push(last); last = null; parts = []; } };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    let i = 0, depth = 0;
    if (flowed) { while (raw.charCodeAt(i) === 62) i++; depth = i; if (raw[i] === ' ') i++; }
    else while (raw[i] === '>') { i++; depth++; if (raw[i] === ' ') i++; }
    depth = Math.min(depth, MAX_DEPTH);
    const content = i ? raw.slice(i) : raw;
    // the separator is exactly `-- ` (RFC 3676, 4.3; Usenet's convention), unquoted, and only the first one
    const signature = !signed && raw === '-- ';
    if (signature) signed = true;
    if (soft && last && last.depth === depth && !signature && content !== '-- ' && !blank(content)) {
      if (delsp) parts[parts.length - 1] = parts[parts.length - 1]!.slice(0, -1);
    } else {
      end();
      last = { depth, text: '', signature };
    }
    parts.push(content);
    soft = flowed && content.endsWith(' ') && content !== '-- ';
  }
  end();
  return out;
}

const element = (tag: Element['tag'], children: Node[], more?: Partial<Element>): Element =>
  ({ type: 'element', tag, attrs: {}, style: {}, children, ...more });

/**
 * The blocks of the lines: paragraphs between blank lines, a blockquote per quote level (a change of level ends
 * the paragraph and closes or opens quotes; a blank line only closes them, so no quote is empty), and from the
 * signature on, a signature div holding the rest, its separator the first line of its first paragraph.
 */
function blocks(input: readonly Line[]): Node[] {
  const root: Node[] = [];
  // the children of the quotes open at each depth; [0] is the root's, or the signature's once it starts
  const stack: Node[][] = [root];
  let para: string[] = [];
  let links = MAX_LINKS;
  const flush = () => {
    if (!para.length) return;
    const pieces = autolink(para.join('\n'), links);
    for (const p of pieces) if (typeof p !== 'string') links--;
    const children: Node[] = pieces.map((p) =>
      typeof p === 'string' ? { type: 'text', value: p } : element('a', [{ type: 'text', value: p.text }], { attrs: { href: p.href } }));
    stack[stack.length - 1]!.push(element('p', children, { style: { 'white-space': 'pre-wrap' } }));
    para = [];
  };
  const close = (depth: number) => { while (stack.length - 1 > depth) stack.pop(); };
  for (const line of input) {
    if (line.signature) {
      flush();
      close(0);
      const div = element('div', [], { part: 'signature' });
      stack[0]!.push(div);
      stack[0] = div.children;
    }
    if (line.depth !== stack.length - 1) flush();
    if (blank(line.text)) { flush(); close(line.depth); continue; }
    close(line.depth);
    while (stack.length - 1 < line.depth) {
      const quote = element('blockquote', [], { part: 'quote' });
      stack[stack.length - 1]!.push(quote);
      stack.push(quote.children);
    }
    para.push(line.text);
  }
  flush();
  return root;
}
