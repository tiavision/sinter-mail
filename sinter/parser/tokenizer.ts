// The HTML standard's tokenizer, for a whole string at once. It hands the tree builder (tree.ts) its tokens
// as calls: runs of text with their character references decoded, start and end tags, comments, doctypes
// and the end of the input. The tree builder answers each start tag with the state the text after it is
// read in: RCDATA (`<title>`, `<textarea>`), RAWTEXT (`<style>`, `<xmp>`, `<iframe>`, `<noembed>`,
// `<noframes>`, `<noscript>`), script data or PLAINTEXT.
//
// The standard's states are a character-at-a-time machine; most of them only decide where a token ends, so
// here they are scans: a comment ends at the first `-->` or `--!>`, a doctype at the first `>`, raw text at
// its end tag. Every scan moves forward, so the time is linear in the input.
import { ENTITIES, LEGACY } from './entities.js';

export type Attrs = [name: string, value: string][];

export interface Sink {
  /** text, never empty: NUL kept in data (the tree builder drops or replaces it), U+FFFD in raw text */
  text(s: string): void;
  /** a start tag; returns the state its content is read in (DATA, RCDATA, RAWTEXT, SCRIPT, PLAINTEXT) */
  start(name: string, attrs: Attrs, selfClosing: boolean): number;
  end(name: string): void;
  comment(): void;
  doctype(name: string | null, publicId: string | null, systemId: string | null, forceQuirks: boolean): void;
  /** whether `<![CDATA[` opens a CDATA section here (the current node is foreign) or a bogus comment */
  cdata(): boolean;
  eof(): void;
}

export const DATA = 0, RCDATA = 1, RAWTEXT = 2, SCRIPT = 3, PLAINTEXT = 4;

const WS = /[\t\n\f ]*/y;
const TAG_NAME = /[^\t\n\f />]*/y;
const ATTR_NAME = /[^\t\n\f />=]*/y;
const UNQUOTED = /[^\t\n\f >]*/y;
const COMMENT_END = /--!?>/g;
const REFERENCE = /&(?:#[xX]([\dA-Fa-f]+);?|#(\d+);?|([A-Za-z\d]{1,32})(;?))/g;
// numeric references to 0x80\u20130x9F mean what windows-1252 has there; a code with no character there stays itself
const C1 = '\u20AC\x81\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\x8D\u017D\x8F\x90\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\x9D\u017E\u0178';

/** ASCII lowercase, as the standard lowercases names (`toLowerCase` would also fold other letters) */
export const lower = (s: string): string => (/[A-Z]/.test(s) ? s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)) : s);
const nul = (s: string): string => (s.includes('\0') ? s.replace(/\0/g, '\uFFFD') : s);
const isAlpha = (c: number): boolean => ((c | 32) >= 97 && (c | 32) <= 122);

/** `s` with its character references decoded; in an attribute value, a legacy one before `=` or a letter stays */
export function decode(s: string, inAttr: boolean): string {
  if (!s.includes('&')) return s;
  return s.replace(REFERENCE, (m, hex: string | undefined, dec: string | undefined, name: string | undefined, semi: string, at: number) => {
    if (name === undefined) {
      const digits = (hex ?? dec!).replace(/^0+/, '');
      const n = digits.length > 8 ? 0x110000 : parseInt(digits || '0', hex === undefined ? 10 : 16);
      return n === 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF) ? '\uFFFD' : n >= 0x80 && n <= 0x9F ? C1[n - 0x80] : String.fromCodePoint(n);
    }
    if (semi && ENTITIES.has(name)) return ENTITIES.get(name)!;
    // the longest name that is a reference without `;` (at most six letters long)
    for (let k = Math.min(name.length, 6); k > 1; k--) {
      const prefix = name.slice(0, k);
      if (!LEGACY.has(prefix)) continue;
      const next = k < name.length ? name[k] : semi || s[at + m.length];
      if (inAttr && next !== undefined && /[=\dA-Za-z]/.test(next)) return m;
      return ENTITIES.get(prefix)! + m.slice(k + 1);
    }
    return m;
  });
}

/** tokenizes `input`, calling `sink` for each token in order */
export function tokenize(input: string, sink: Sink): void {
  const s = input.includes('\r') ? input.replace(/\r\n?/g, '\n') : input; // newlines normalized first, as the standard does
  const n = s.length;
  let pos = 0, text = '', state = DATA, last = '';

  const flush = (): void => {
    if (text) sink.text(text);
    text = '';
  };
  const skip = (re: RegExp): string => {
    re.lastIndex = pos;
    const m = re.exec(s)![0];
    pos += m.length;
    return m;
  };
  /** `</name` followed by whitespace, `/` or `>` at `i`: the end tag raw text ends at */
  const endsAt = (i: number, name: string): boolean =>
    s.charCodeAt(i) === 60 && s.charCodeAt(i + 1) === 47 && lower(s.substr(i + 2, name.length)) === name && /[\t\n\f />]/.test(s.charAt(i + 2 + name.length));

  /** reads a tag from `pos` (its name's first letter); returns false at the end of the input, which drops it */
  const tag = (isEnd: boolean): boolean => {
    const name = lower(nul(skip(TAG_NAME)));
    const attrs: Attrs = [];
    let names: Set<string> | null = null, selfClosing = false;
    for (;;) {
      skip(WS);
      if (pos >= n) return false;
      let c = s[pos];
      if (c === '>') break;
      if (c === '/') {
        pos++;
        if (s[pos] === '>') { selfClosing = true; break; }
        continue;
      }
      pos++; // the name's first character, which may be `=`
      const an = lower(nul(c + skip(ATTR_NAME)));
      skip(WS);
      let value = '';
      if (s[pos] === '=') {
        pos++;
        skip(WS);
        c = s[pos];
        if (c === '"' || c === "'") {
          const close = s.indexOf(c, pos + 1);
          if (close < 0) return false;
          value = s.slice(pos + 1, close);
          pos = close + 1;
        } else value = skip(UNQUOTED);
        value = nul(decode(value, true));
      }
      // the first of duplicate names is kept; a set only for tags with many attributes
      if (attrs.length > 16 && !names) names = new Set(attrs.map((a) => a[0]));
      if (names ? names.has(an) : attrs.some((a) => a[0] === an)) continue;
      names?.add(an);
      attrs.push([an, value]);
    }
    pos++;
    if (isEnd) sink.end(name);
    else {
      state = sink.start(name, attrs, selfClosing);
      last = name;
    }
    return true;
  };

  while (pos < n) {
    if (state !== DATA) {
      // raw text: up to its end tag (script data with its escapes), or to the end of the input
      let end = n;
      if (state === SCRIPT) end = scriptEnd(s, pos);
      else if (state !== PLAINTEXT) for (let i = s.indexOf('</', pos); i >= 0; i = s.indexOf('</', i + 2)) if (endsAt(i, last)) { end = i; break; }
      const raw = nul(s.slice(pos, end));
      text += state === RCDATA ? decode(raw, false) : raw;
      pos = end;
      state = DATA;
      continue;
    }
    let i = s.indexOf('<', pos);
    if (i < 0) i = n;
    if (i > pos) text += decode(s.slice(pos, i), false);
    pos = i;
    if (pos >= n) break;
    const c = s.charCodeAt(pos + 1);
    if (isAlpha(c)) {
      flush();
      pos++;
      if (!tag(false)) break;
    } else if (c === 47) { // `</`
      const d = s.charCodeAt(pos + 2);
      if (isAlpha(d)) {
        flush();
        pos += 2;
        if (!tag(true)) break;
      } else if (d === 62) pos += 3; // `</>` is nothing
      else if (pos + 2 >= n) { text += '</'; pos = n; }
      else bogus();
    } else if (c === 33) { // `<!`
      if (s.startsWith('<!--', pos)) {
        flush();
        pos += 4;
        if (s[pos] === '>') pos++;
        else if (s.startsWith('->', pos)) pos += 2;
        else {
          COMMENT_END.lastIndex = pos;
          const m = COMMENT_END.exec(s);
          pos = m ? m.index + m[0].length : n;
        }
        sink.comment();
      } else if (lower(s.substr(pos + 2, 7)) === 'doctype') {
        flush();
        let close = s.indexOf('>', pos + 9);
        if (close < 0) close = n;
        doctype(s.slice(pos + 9, close), close === n, sink);
        pos = close + 1;
      } else if (s.startsWith('<![CDATA[', pos) && sink.cdata()) {
        let close = s.indexOf(']]>', pos + 9);
        if (close < 0) close = n;
        text += s.slice(pos + 9, close);
        pos = close + 3;
      } else bogus();
    } else if (c === 63) bogus(); // `<?`
    else {
      text += '<';
      pos++;
    }
  }
  flush();
  sink.eof();

  /** a bogus comment: up to the next `>` */
  function bogus(): void {
    flush();
    const close = s.indexOf('>', pos + 2);
    pos = close < 0 ? n : close + 1;
    sink.comment();
  }
}

/** where script data from `pos` ends: the standard's escaped and double-escaped states, which `<!--` opens */
function scriptEnd(s: string, pos: number): number {
  const n = s.length;
  // 0 data, 1 escaped, 2 double escaped; dashes counts the `-` just read in an escaped state
  let st = 0, dashes = 0;
  const word = (i: number): string => /^[A-Za-z]*/.exec(s.slice(i, i + 7))![0];
  const isScript = (i: number): boolean => lower(word(i)) === 'script' && /[\t\n\f />]/.test(s.charAt(i + 6));
  for (let i = pos; i < n; i++) {
    const c = s[i];
    if (c === '-') {
      if (st) dashes++;
      continue;
    }
    if (c === '>' && st && dashes >= 2) { st = 0; dashes = 0; continue; }
    dashes = 0;
    if (c !== '<') continue;
    if (st === 0) {
      if (s.startsWith('</', i) && isScript(i + 2)) return i;
      if (s.startsWith('<!--', i)) { st = 1; dashes = 2; i += 3; }
    } else if (st === 1) {
      if (s[i + 1] === '/') { if (isScript(i + 2)) return i; }
      else if (isScript(i + 1)) { st = 2; i += 7; }
    } else if (s[i + 1] === '/' && isScript(i + 2)) { st = 1; i += 8; }
  }
  return n;
}

/** a doctype's text after `<!DOCTYPE`, up to its `>` (or the end of the input: `eof`), read as the standard's doctype states read it */
function doctype(d: string, eof: boolean, sink: Sink): void {
  const n = d.length;
  // `trailing`: text after the system identifier, the one bogus doctype that does not force quirks
  let i = 0, quirks = false, trailing = false;
  const ws = (): void => { while (i < n && /[\t\n\f ]/.test(d[i])) i++; };
  /** a quoted identifier, or null where there is none */
  const quoted = (): string | null => {
    ws();
    const q = d[i];
    if (q !== '"' && q !== "'") { quirks = true; i = n; return null; }
    let close = d.indexOf(q, i + 1);
    if (close < 0) { quirks = true; close = n; } // ended by `>`
    const id = nul(d.slice(i + 1, close));
    i = close + 1;
    return id;
  };
  ws();
  let j = i;
  while (j < n && !/[\t\n\f ]/.test(d[j])) j++;
  const name = i < n ? lower(nul(d.slice(i, j))) : null;
  if (name === null) quirks = true;
  i = j;
  ws();
  let publicId: string | null = null, systemId: string | null = null;
  if (i < n) {
    const keyword = lower(d.substr(i, 6));
    i += 6;
    if (keyword === 'public') {
      publicId = quoted();
      ws();
      if (i < n) systemId = quoted();
    } else if (keyword === 'system') systemId = quoted();
    else { quirks = true; i = n; }
    ws();
    if (i < n) trailing = true;
  }
  // the end of the input forces quirks in every doctype state but the bogus one
  sink.doctype(name, publicId, systemId, quirks || (eof && !trailing));
}
