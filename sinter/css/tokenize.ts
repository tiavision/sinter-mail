// The CSS tokenizer, after CSS Syntax Level 3 (§4), and the step after it: component values (§5.4.7),
// built with a stack, not recursion, so a hostile run of `((((` cannot exhaust the call stack.
//
// Escapes are decoded here, once: every name and string downstream holds the characters, never a
// backslash, and every value written out is re-serialized from these tokens (values.ts).

export type Token =
  | { t: 'ident'; v: string }
  | { t: 'function'; v: string }
  | { t: 'at-keyword'; v: string }
  | { t: 'hash'; v: string; id: boolean }
  | { t: 'string'; v: string }
  | { t: 'bad-string' }
  | { t: 'url'; v: string }
  | { t: 'bad-url' }
  | { t: 'delim'; v: string }
  | { t: 'number'; n: number; int: boolean; s: string }
  | { t: 'percentage'; n: number; s: string }
  | { t: 'dimension'; n: number; int: boolean; s: string; unit: string }
  | { t: 'ws' }
  | { t: 'cdo' }
  | { t: 'cdc' }
  | { t: ':' }
  | { t: ';' }
  | { t: ',' }
  | { t: '[' }
  | { t: ']' }
  | { t: '(' }
  | { t: ')' }
  | { t: '{' }
  | { t: '}' };

/** a function with its arguments, or a block (`{}`, `()`, `[]`) with its contents */
export type Func = { t: 'func'; name: string; args: CV[] };
export type Block = { t: 'block'; open: '{' | '(' | '['; items: CV[] };
/** a component value: a preserved token, a function or a block */
export type CV = Exclude<Token, { t: 'function' | '(' | '[' | '{' }> | Func | Block;

const WS: Token = { t: 'ws' };

const isDigit = (c: number) => c >= 48 && c <= 57;
const isHex = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 0x80;
const isName = (c: number) => isNameStart(c) || isDigit(c) || c === 45;
const isWs = (c: number) => c === 10 || c === 9 || c === 32;
const isNonPrintable = (c: number) => (c >= 0 && c <= 8) || c === 11 || (c >= 14 && c <= 31) || c === 127;

/** the tokens of `input` (preprocessed as §3.3 says: newlines normalized, NUL and surrogates replaced) */
export function tokenize(input: string): Token[] {
  const s = input.replace(/\r\n?|\f/g, '\n').replace(/\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
  const n = s.length;
  const out: Token[] = [];
  let i = 0;
  // code unit at i + k, or -1 past the end (EOF)
  const at = (k = 0) => (i + k < n ? s.charCodeAt(i + k) : -1);
  const validEscape = (k: number) => at(k) === 92 && at(k + 1) !== 10 && at(k + 1) !== -1;
  const startsIdent = (k: number) => {
    const c = at(k);
    if (c === 45) return isNameStart(at(k + 1)) || at(k + 1) === 45 || validEscape(k + 1);
    if (isNameStart(c)) return true;
    return validEscape(k);
  };
  const startsNumber = (k: number) => {
    const c = at(k);
    if (c === 43 || c === 45) return isDigit(at(k + 1)) || (at(k + 1) === 46 && isDigit(at(k + 2)));
    if (c === 46) return isDigit(at(k + 1));
    return isDigit(c);
  };
  // §4.3.7, with i just past the backslash
  const escape = (): string => {
    const c = at();
    if (c === -1) return '�';
    if (isHex(c)) {
      let j = 0;
      while (j < 6 && isHex(at())) { j++; i++; }
      const cp = parseInt(s.slice(i - j, i), 16);
      if (isWs(at())) i++;
      return cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff ? '�' : String.fromCodePoint(cp);
    }
    // a whole code point, a surrogate pair included
    const cp = s.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    return String.fromCodePoint(cp);
  };
  const name = (): string => {
    let r = '';
    let from = i;
    for (;;) {
      const c = at();
      if (isName(c)) { i++; continue; }
      if (validEscape(0)) {
        r += s.slice(from, i);
        i++;
        r += escape();
        from = i;
        continue;
      }
      break;
    }
    return r + s.slice(from, i);
  };
  const number = (): { n: number; int: boolean; s: string } => {
    const from = i;
    let int = true;
    if (at() === 43 || at() === 45) i++;
    while (isDigit(at())) i++;
    if (at() === 46 && isDigit(at(1))) { int = false; i += 2; while (isDigit(at())) i++; }
    const e = at();
    if ((e === 69 || e === 101) && (isDigit(at(1)) || ((at(1) === 43 || at(1) === 45) && isDigit(at(2))))) {
      int = false;
      i += 2;
      while (isDigit(at())) i++;
    }
    const repr = s.slice(from, i);
    return { n: Number(repr), int, s: repr };
  };
  const numeric = (): Token => {
    const num = number();
    if (startsIdent(0)) return { t: 'dimension', ...num, unit: name() };
    if (at() === 37) { i++; return { t: 'percentage', n: num.n, s: num.s }; }
    return { t: 'number', ...num };
  };
  // §4.3.6, with i just past `url(` and its whitespace
  const url = (): Token => {
    let v = '';
    while (isWs(at())) i++;
    for (;;) {
      const c = at();
      if (c === 41) { i++; return { t: 'url', v }; }
      if (c === -1) return { t: 'url', v };
      if (isWs(c)) {
        while (isWs(at())) i++;
        if (at() === 41) { i++; return { t: 'url', v }; }
        if (at() === -1) return { t: 'url', v };
        badUrl();
        return { t: 'bad-url' };
      }
      if (c === 34 || c === 39 || c === 40 || isNonPrintable(c)) { badUrl(); return { t: 'bad-url' }; }
      if (c === 92) {
        if (validEscape(0)) { i++; v += escape(); continue; }
        badUrl();
        return { t: 'bad-url' };
      }
      v += s[i++];
    }
  };
  const badUrl = () => {
    for (;;) {
      const c = at();
      if (c === -1) return;
      if (c === 41) { i++; return; }
      if (validEscape(0)) { i++; escape(); continue; }
      i++;
    }
  };
  const identLike = (): Token => {
    const v = name();
    if (v.toLowerCase() === 'url' && at() === 40) {
      i++;
      // `url(` followed by a quote is an ordinary function (its argument a string token)
      let k = 0;
      while (isWs(at(k)) && isWs(at(k + 1))) k++;
      const q = isWs(at(k)) ? at(k + 1) : at(k);
      if (q === 34 || q === 39) { i += k; return { t: 'function', v }; }
      return url();
    }
    if (at() === 40) { i++; return { t: 'function', v }; }
    return { t: 'ident', v };
  };
  const string = (q: number): Token => {
    let v = '';
    let from = i;
    for (;;) {
      const c = at();
      if (c === q) { v += s.slice(from, i); i++; return { t: 'string', v }; }
      if (c === -1) return { t: 'string', v: v + s.slice(from, i) };
      if (c === 10) return { t: 'bad-string' }; // the newline is left for the next token
      if (c === 92) {
        v += s.slice(from, i);
        i++;
        if (at() === -1) { from = i; continue; }
        if (at() === 10) { i++; from = i; continue; }
        v += escape();
        from = i;
        continue;
      }
      i++;
    }
  };

  while (i < n) {
    const c = at();
    // comments
    if (c === 47 && at(1) === 42) {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (isWs(c)) {
      while (isWs(at())) i++;
      out.push(WS);
      continue;
    }
    if (c === 34 || c === 39) { i++; out.push(string(c)); continue; }
    if (c === 35) {
      if (isName(at(1)) || validEscape(1)) {
        i++;
        const id = startsIdent(0);
        out.push({ t: 'hash', v: name(), id });
      } else { i++; out.push({ t: 'delim', v: '#' }); }
      continue;
    }
    if (startsNumber(0)) { out.push(numeric()); continue; }
    if (c === 45 && at(1) === 45 && at(2) === 62) { i += 3; out.push({ t: 'cdc' }); continue; }
    if (startsIdent(0)) { out.push(identLike()); continue; }
    if (c === 60 && at(1) === 33 && at(2) === 45 && at(3) === 45) { i += 4; out.push({ t: 'cdo' }); continue; }
    if (c === 64) {
      i++;
      if (startsIdent(0)) out.push({ t: 'at-keyword', v: name() });
      else out.push({ t: 'delim', v: '@' });
      continue;
    }
    i++;
    switch (c) {
      case 40: out.push({ t: '(' }); break;
      case 41: out.push({ t: ')' }); break;
      case 44: out.push({ t: ',' }); break;
      case 58: out.push({ t: ':' }); break;
      case 59: out.push({ t: ';' }); break;
      case 91: out.push({ t: '[' }); break;
      case 93: out.push({ t: ']' }); break;
      case 123: out.push({ t: '{' }); break;
      case 125: out.push({ t: '}' }); break;
      default: {
        // one code point (a lone backslash is a parse error and a delim)
        const cp = s.codePointAt(i - 1)!;
        if (cp > 0xffff) i++;
        out.push({ t: 'delim', v: String.fromCodePoint(cp) });
      }
    }
  }
  return out;
}

const MIRROR = { '(': ')', '[': ']', '{': '}' } as const;

/**
 * The component values of `tokens` (§5.4.7): functions and blocks with their contents, closed by their
 * mirror token or by the end. A stray closing token is kept as itself.
 */
export function componentValues(tokens: Token[]): CV[] {
  const root: CV[] = [];
  // the open containers, innermost last, each with the token that closes it
  const stack: { items: CV[]; close: ')' | ']' | '}' }[] = [];
  let items = root;
  for (const tok of tokens) {
    const top = stack[stack.length - 1];
    if (top && tok.t === top.close) {
      stack.pop();
      items = stack.length ? stack[stack.length - 1].items : root;
      continue;
    }
    if (tok.t === 'function') {
      const f: Func = { t: 'func', name: tok.v, args: [] };
      items.push(f);
      stack.push({ items: f.args, close: ')' });
      items = f.args;
    } else if (tok.t === '(' || tok.t === '[' || tok.t === '{') {
      const b: Block = { t: 'block', open: tok.t, items: [] };
      items.push(b);
      stack.push({ items: b.items, close: MIRROR[tok.t] });
      items = b.items;
    } else items.push(tok);
  }
  return root;
}

/** `input` as component values */
export const parseComponents = (input: string): CV[] => componentValues(tokenize(input));
