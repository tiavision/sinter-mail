// A throwaway app that uses the package as an app does: installed in node_modules (here a link to this
// folder, as a workspace or `npm link` makes it), named in `sinter({ components })`, and re-exported as
// the namespace `mail` from the app's helpers module.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Body, Element, Node, Style, Tag } from '../sinter/sinter.types.js';

export const PKG = resolve(import.meta.dirname, '..');
/** the sinter this package is tested against: the one installed beside it */
export const SINTER = realpathSync(join(PKG, 'node_modules/@tiaforge-ui/sinter'));

const HELPERS = "export * as mail from '@tiaforge-ui/sinter-mail';\n";
const TYPES = "export type { Body, Element } from '@tiaforge-ui/sinter-mail';\n";

/** a new app folder with `files` written into it; `remove()` deletes it */
export function app(files: Record<string, string | Uint8Array>): { root: string; remove: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'sinter-mail-app-'));
  const all = { 'src/sinter.helpers.ts': HELPERS, 'src/sinter.types.ts': TYPES, ...files };
  for (const [f, s] of Object.entries(all)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), s);
  }
  mkdirSync(join(root, 'node_modules/@tiaforge-ui'), { recursive: true });
  symlinkSync(PKG, join(root, 'node_modules/@tiaforge-ui/sinter-mail'), 'dir');
  symlinkSync(SINTER, join(root, 'node_modules/@tiaforge-ui/sinter'), 'dir');
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/** a page: a head with `head`, a body with `body` */
export const page = (body: string, head = '') => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>t</title>${head}</head>
<body>
${body}
</body>
</html>
`;

// ── Trees ─────────────────────────────────────────────────────────────────────────────────────────────

export const text = (value: string): Node => ({ type: 'text', value });
export const el = (tag: Tag, attrs: Element['attrs'] = {}, style: Style = {}, children: Array<Node | string> = []): Element =>
  ({ type: 'element', tag, attrs, style, children: children.map((c) => (typeof c === 'string' ? text(c) : c)) });

/** the elements of a tree, depth first */
export function* elements(n: Body | Node): Generator<Element> {
  if (n.type === 'element') yield n;
  if (n.type !== 'text') for (const c of n.children) yield* elements(c);
}

/**
 * A newsletter of about `count` elements: a centred table with nested tables of styled cells, as email
 * builders write them. Each block is an outer row holding an inner table of 2 × 3 cells, each cell with a
 * paragraph, a link and a span, every element with several properties.
 */
export function newsletter(count: number): Body {
  const cell = (i: number) => el('td', { colspan: '1' }, {
    'padding-top': '8px', 'padding-right': '8px', 'padding-bottom': '8px', 'padding-left': '8px', 'vertical-align': 'top',
    'background-color': i % 2 ? 'rgb(250, 250, 250)' : 'rgb(255, 255, 255)', 'border-bottom-width': '1px', 'border-bottom-style': 'solid', 'border-bottom-color': 'rgb(221, 221, 221)', width: '33%',
  }, [el('p', {}, { 'margin-top': '0px', 'margin-bottom': '4px', 'font-size': '14px', 'line-height': '20px', color: 'rgb(51, 51, 51)', 'font-family': 'Arial, sans-serif' }, [
    'Item ', el('span', {}, { 'font-weight': '700', color: 'rgb(0, 51, 102)' }, [String(i)]), ' ', el('a', { href: `https://example.com/item/${i}` }, { color: 'rgb(0, 102, 204)', 'text-decoration': 'underline' }, ['more']),
  ])]);
  // one block: tr, td, table, tbody, 2 × (tr + 3 × (td, p, span, a)) = 4 + 2 × 13 = 30 elements
  const block = (b: number) => el('tr', {}, {}, [el('td', {}, { 'padding-top': '16px', 'padding-bottom': '16px' }, [
    el('table', {}, { width: '100%', 'border-collapse': 'collapse', 'border-spacing': '0px', 'table-layout': 'fixed' }, [el('tbody', {}, {}, [0, 1].map((r) => el('tr', {}, {}, [0, 1, 2].map((c) => cell(b * 6 + r * 3 + c)))))]),
  ])]);
  const blocks = Math.max(1, Math.round((count - 3) / 30));
  return {
    type: 'body', style: { 'background-color': 'rgb(238, 238, 238)' }, images: { origins: [] },
    children: [el('table', {}, { width: '600px', 'margin-left': 'auto', 'margin-right': 'auto', 'background-color': 'rgb(255, 255, 255)' }, [
      el('tbody', {}, {}, Array.from({ length: blocks }, (_, b) => block(b))),
    ])],
  };
}
