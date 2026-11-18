// The stylesheet and declaration-list parsers (CSS Syntax Level 3, §5), over component values: what a
// browser keeps of a stylesheet's structure before it looks at selectors and values. Rules nested in a
// style rule (CSS Nesting) are skipped whole, as the current syntax says to consume them, not applied.
import { parseComponents, type Block, type CV } from './tokenize.js';

export interface Declaration {
  /** lowercase (custom properties keep their case, and are dropped later anyway) */
  name: string;
  value: CV[];
  important: boolean;
}

export type Rule =
  | { t: 'style'; prelude: CV[]; declarations: Declaration[] }
  | { t: 'at'; name: string; prelude: CV[]; block: Block | null };

/** the rules of a stylesheet (§5.3.3) */
export function parseStylesheet(css: string): Rule[] {
  return rules(parseComponents(css), true);
}

/** the declarations of a `style` attribute (§5.3.7) */
export function parseDeclarations(css: string): Declaration[] {
  return declarations(parseComponents(css));
}

const isWs = (v: CV | undefined) => v?.t === 'ws';

/** a list of rules from component values (§5.4.1); CDO and CDC are skipped at the top level only */
export function rules(items: CV[], top: boolean): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < items.length) {
    const v = items[i];
    if (v.t === 'ws') { i++; continue; }
    if (v.t === 'cdo' || v.t === 'cdc') {
      if (top) { i++; continue; }
    }
    if (v.t === 'at-keyword') {
      // an at-rule ends at a `;` or with its `{}` block
      const prelude: CV[] = [];
      i++;
      let block: Block | null = null;
      while (i < items.length) {
        const w = items[i++];
        if (w.t === ';') break;
        if (w.t === 'block' && w.open === '{') { block = w; break; }
        prelude.push(w);
      }
      out.push({ t: 'at', name: v.v.toLowerCase(), prelude, block });
      continue;
    }
    // a qualified rule: its prelude, up to its `{}` block; with no block it is dropped
    const prelude: CV[] = [];
    let block: Block | null = null;
    while (i < items.length) {
      const w = items[i++];
      if (w.t === 'block' && w.open === '{') { block = w; break; }
      prelude.push(w);
    }
    if (block) out.push({ t: 'style', prelude, declarations: declarations(block.items) });
  }
  return out;
}

/**
 * The declarations of a block's contents (§5.4.5, with nesting): `name: value [!important]` up to a `;`
 * at this level; an at-rule or a nested rule is consumed and skipped; anything else is dropped up to
 * the next `;`.
 */
export function declarations(items: CV[]): Declaration[] {
  const out: Declaration[] = [];
  let i = 0;
  while (i < items.length) {
    const v = items[i];
    if (v.t === 'ws' || v.t === ';') { i++; continue; }
    if (v.t === 'at-keyword') {
      i++;
      while (i < items.length) {
        const w = items[i++];
        if (w.t === ';' || (w.t === 'block' && w.open === '{')) break;
      }
      continue;
    }
    // the item: up to a `;`, or a nested rule's `{}` block
    const from = i;
    let nested = false;
    while (i < items.length && items[i].t !== ';') {
      const w = items[i++];
      if (w.t === 'block' && w.open === '{') { nested = true; break; }
    }
    if (nested) continue;
    const d = declaration(items.slice(from, i));
    if (d) out.push(d);
  }
  return out;
}

function declaration(items: CV[]): Declaration | null {
  const head = items[0];
  if (head?.t !== 'ident') return null;
  let k = 1;
  while (isWs(items[k])) k++;
  if (items[k]?.t !== ':') return null;
  const value = items.slice(k + 1);
  // trailing whitespace, then `!important` (with whitespace allowed between `!` and the keyword)
  const trim = () => { while (isWs(value[value.length - 1])) value.pop(); };
  trim();
  let important = false;
  const last = value[value.length - 1];
  if (last?.t === 'ident' && last.v.toLowerCase() === 'important') {
    let j = value.length - 2;
    while (isWs(value[j])) j--;
    const bang = value[j];
    if (bang?.t === 'delim' && bang.v === '!') {
      important = true;
      value.length = j;
      trim();
    }
  }
  while (isWs(value[0])) value.shift();
  const name = head.v.startsWith('--') ? head.v : head.v.toLowerCase();
  return { name, value, important };
}
