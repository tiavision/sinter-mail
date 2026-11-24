// Address lists (RFC 5322, 3.4, with the obsolete forms of 4.4) and the address comparison of protected headers
// (docs/proposals/sinter-mail-mime.md, sections 3 and 6; RFC 9788, 4.4.5).
//
// The field is tokenized first, then read by the grammar, and only then are encoded words decoded, in display
// names (quoted or not: Outlook encodes inside quotes) and comments, never in an addr-spec: a decoded `@`, `,`, `<`
// or `"` is text (Mailsploit, "Splitting the email atom"). An addr-spec the grammar cannot read one way only is
// `address: null` and `address-ambiguous`, never a guess (Python's CVE-2023-27043, postal-mime's domain
// truncation, Nodemailer's quoted local part). Forms that other software reads differently (a source route, the
// percent hack, a UUCP path, a quoted `@`, a domain literal, an encoded word in the local part) are kept and
// marked `suspicious`. Everything is one pass over tokens, without recursion; comment nesting is counted.
import type { Address } from './types.js';
import { asciiLower } from './charset.js';
import { once, type Sink } from './decode.js';
import { atomPieces, decodeWords, fieldBudget, joinPieces, PHRASE_WORDS, wordsIn, type Piece, type WordBudget } from './headers.js';

/** addresses read from one field; past it, the rest is dropped (`field-dropped`) */
export const MAX_ADDRESSES = 1_000;
/** comments nested deeper make the mailbox they are in unreadable */
export const COMMENT_DEPTH = 8;

type Tok =
  | { k: 'atom' | 'quoted' | 'literal' | 'comment'; v: string; sp: boolean; bad: boolean }
  | { k: 'special'; v: string; sp: boolean; bad: false };

const ws = (c: number) => c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
/** what ends an atom: whitespace, RFC 5322's specials, and `)`, `]`, `\` (which are junk outside their pairs) */
const atomEnd = (c: number) => ws(c) || c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d
  || c === 0x3a || c === 0x3b || c === 0x40 || c === 0x5c || c === 0x2c || c === 0x2e || c === 0x22;
/** NUL, C0 controls and DEL: never in an address */
const control = (c: number) => c < 0x20 || c === 0x7f;

/** the field's tokens; an unterminated comment, quoted string or literal, or a comment nested too deep, is `bad` */
function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let sp = false;
  for (let i = 0; i < s.length;) {
    const c = s.charCodeAt(i);
    if (ws(c)) { sp = true; i++; continue; }
    if (c === 0x28) {
      const parts: string[] = [];
      let depth = 0, bad = false, from = i + 1, closed = false;
      for (; i < s.length; i++) {
        const d = s.charCodeAt(i);
        if (d === 0x5c) { if (depth <= COMMENT_DEPTH) parts.push(s.slice(from, i)); from = ++i; }
        else if (d === 0x28) { if (++depth > COMMENT_DEPTH) bad = true; }
        else if (d === 0x29 && --depth === 0) { closed = true; break; }
      }
      if (!bad) parts.push(s.slice(from, i));
      out.push({ k: 'comment', v: bad ? '' : parts.join(''), sp, bad: bad || !closed });
      i++;
      sp = true;
      continue;
    }
    if (c === 0x22 || c === 0x5b) {
      const close = c === 0x22 ? 0x22 : 0x5d;
      const parts: string[] = [];
      let from = ++i, closed = false, bad = false;
      for (; i < s.length; i++) {
        const d = s.charCodeAt(i);
        if (d === 0x5c) { parts.push(s.slice(from, i)); from = ++i; }
        else if (d === close) { closed = true; break; }
        else if (c === 0x5b && d === 0x5b) bad = true;
      }
      parts.push(s.slice(from, Math.min(i, s.length)));
      out.push({ k: c === 0x22 ? 'quoted' : 'literal', v: parts.join(''), sp, bad: bad || !closed });
      i++;
      sp = false;
      continue;
    }
    if (c === 0x3c || c === 0x3e || c === 0x3a || c === 0x3b || c === 0x40 || c === 0x2c || c === 0x2e) {
      out.push({ k: 'special', v: s[i]!, sp, bad: false });
      i++;
      sp = false;
      continue;
    }
    if (c === 0x29 || c === 0x5d || c === 0x5c) {
      out.push({ k: 'atom', v: s[i]!, sp, bad: true });
      i++;
      sp = false;
      continue;
    }
    const from = i;
    while (i < s.length && !atomEnd(s.charCodeAt(i))) i++;
    out.push({ k: 'atom', v: s.slice(from, i), sp, bad: false });
    sp = false;
  }
  return out;
}

const isSpecial = (t: Tok | undefined, v: string) => t !== undefined && t.k === 'special' && t.v === v;

/**
 * A phrase's tokens as pieces to decode: words and dots, a space where the sender had whitespace or a comment.
 * Atoms and dots with no whitespace between them are one word again (`=?utf-8?Q?J._M=C3=BCller?=`, which the
 * tokenizer split at its dot), and that word is an encoded word only as a whole (bounded by whitespace, a special
 * other than `.` or the field's ends: `=?utf8?q?=61=62=63?=<a@b>` has one); in a quoted string, its
 * whitespace-delimited words are (Outlook), one glued to other text inside it stays literal. The pieces stop
 * after the `PHRASE_WORDS + 1`th encoded word: `joinPieces` drops the rest (`field-dropped`) all the same.
 */
function phrase(toks: readonly Tok[]): { pieces: Piece[]; valid: boolean } {
  const pieces: Piece[] = [];
  let valid = true, words = 0, started = false, run: string | null = null;
  const add = (p: Piece) => {
    if (words > PHRASE_WORDS) return;
    if (typeof p !== 'string') words++;
    pieces.push(p);
  };
  const flush = () => {
    if (run === null) return;
    const ps = atomPieces(run);
    run = null;
    for (let k = 0; k < ps.length; k++) add(ps[k]!);
  };
  for (const t of toks) {
    if (t.k === 'comment') { if (t.bad) valid = false; continue; }
    if (t.bad || t.k === 'literal' || (t.k === 'special' && t.v !== '.')) valid = false;
    const joinable = (t.k === 'atom' && !t.bad) || isSpecial(t, '.');
    if (joinable && run !== null && !t.sp) { run += t.v; continue; }
    flush();
    if (started && t.sp) add(' ');
    started = true;
    if (joinable) run = t.v;
    else if (t.k === 'quoted') { const ps = wordsIn(t.v); for (let k = 0; k < ps.length && words <= PHRASE_WORDS; k++) add(ps[k]!); }
    else add(t.k === 'literal' ? '[' + t.v + ']' : t.v);
  }
  flush();
  return { pieces, valid };
}

/**
 * What a local part cannot hold and be typed back: controls (C0, DEL, C1), format characters (the bidirectional
 * controls, U+200B, U+FEFF, …), Unicode spaces and line separators (U+00A0, U+2000 to U+200A, U+2028, U+2029,
 * …), and lone surrogates; an ASCII space only inside quotes.
 */
const UNSAFE_LOCAL = /(?! )[\p{Cc}\p{Cf}\p{Z}\ud800-\udfff]/u;

/** atext, dots between: a local part that needs no quotes (non-ASCII allowed, RFC 6532) */
function dotAtom(s: string): boolean {
  if (!s || s.charCodeAt(0) === 0x2e || s.charCodeAt(s.length - 1) === 0x2e) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x2e) { if (s.charCodeAt(i + 1) === 0x2e) return false; continue; }
    if (control(c) || atomEnd(c)) return false;
  }
  return true;
}

/**
 * Whether `domain` (dot-separated atoms) is a host name that WHATWG's URL host parser keeps as it is: the same
 * labels, ASCII ones only lowercased, each non-ASCII one an A-label that decodes back to it (NFC, lowercased).
 * Every `xn--` label of URL's output must be a valid A-label (`aLabelOk`): URL itself does not check them, so a
 * full-width `ｘn--example-` would otherwise pass as `xn--example-`. A label URL maps otherwise (full-width
 * letters, U+3002 as a dot), a number it reads as IPv4 in another form, or a character it treats as structure
 * (`%`, `/`, `#`) fails.
 */
function hostOk(domain: string): boolean {
  let host: string;
  try {
    host = new URL('http://' + domain).hostname;
  } catch {
    return false;
  }
  const a = domain.split('.'), b = host.split('.');
  if (a.length !== b.length) return false;
  const checked = new Map<string, boolean>();
  for (let k = 0; k < a.length; k++) {
    const l = a[k]!, h = b[k]!;
    if (h.startsWith('xn--')) {
      let ok = checked.get(h);
      if (ok === undefined) checked.set(h, ok = aLabelOk(h));
      if (!ok) return false;
    }
    if (/^[\x00-\x7f]*$/.test(l)) { if (asciiLower(l) !== h) return false; }
    else if (!h.startsWith('xn--') || punycode(h.slice(4)) !== l.normalize('NFC').toLowerCase()) return false;
  }
  return true;
}

const BASE = 36, TMIN = 1, TMAX = 26, MAXINT = 0x7fffffff;

function adapt(delta: number, points: number, first: boolean): number {
  delta = first ? Math.floor(delta / 700) : delta >> 1;
  delta += Math.floor(delta / points);
  let k = 0;
  for (; delta > 455; k += BASE) delta = Math.floor(delta / 35);
  return k + Math.floor(36 * delta / (delta + 38));
}

/**
 * RFC 3492's decoding of a label's part after `xn--`, strictly: basic code points before the last `-`, digits
 * after it, every step checked for overflow, no surrogates; null when it fails. Labels are at most 63 characters,
 * so the insertions stay small.
 */
export function punycode(input: string): string | null {
  const out: number[] = [];
  const b = input.lastIndexOf('-');
  for (let j = 0; j < Math.max(b, 0); j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) return null;
    out.push(c);
  }
  let n = 128, i = 0, bias = 72;
  for (let at = b > 0 ? b + 1 : 0; at < input.length;) {
    const old = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (at >= input.length) return null;
      const c = input.charCodeAt(at++);
      const digit = c >= 0x61 && c <= 0x7a ? c - 0x61 : c >= 0x41 && c <= 0x5a ? c - 0x41 : c >= 0x30 && c <= 0x39 ? c - 0x30 + 26 : -1;
      if (digit < 0 || digit > Math.floor((MAXINT - i) / w)) return null;
      i += digit * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      if (w > Math.floor(MAXINT / (BASE - t))) return null;
      w *= BASE - t;
    }
    const len = out.length + 1;
    bias = adapt(i - old, len, old === 0);
    if (Math.floor(i / len) > MAXINT - n) return null;
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    out.splice(i++, 0, n);
  }
  let r = '';
  for (let k = 0; k < out.length; k++) r += String.fromCodePoint(out[k]!);
  return r;
}

/**
 * Whether an A-label (`xn--…`) is one: letters, digits and hyphens, at most 63, strict punycode that decodes to
 * at least one non-ASCII character and to no ASCII but letters, digits and hyphens, and that URL's UTS 46
 * conversion turns back into the same label.
 */
function aLabelOk(label: string): boolean {
  if (label.length > 63 || !/^[A-Za-z0-9-]+$/.test(label)) return false;
  const u = punycode(label.slice(4));
  if (u === null || !/[^\x00-\x7f]/.test(u) || /[\x00-\x2c\x2e-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]/.test(u)) return false;
  try {
    return new URL('http://' + u).hostname === asciiLower(label);
  } catch {
    return false;
  }
}

/** an addr-spec's tokens (no comments) read one way, or null; `flags` collects what makes it suspicious */
function addrSpec(toks: readonly Tok[], flags: { suspicious: boolean }): string | null {
  let at = -1;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    if (t.bad) return null;
    if (isSpecial(t, '@')) { if (at >= 0) return null; at = k; }
    else if (t.k === 'special' && t.v !== '.') return null;
  }
  if (at <= 0 || at === toks.length - 1) return null;
  // the local part: words with dots between (runs of dots kept: one reading only), never two words side by side
  const local: string[] = [];
  let word = false, words = 0;
  for (let k = 0; k < at; k++) {
    const t = toks[k]!;
    if (t.k === 'special') { local.push('.'); word = false; continue; }
    if (word || t.k === 'literal') return null;
    word = true; words++;
    if (UNSAFE_LOCAL.test(t.v)) return null;
    if (t.k === 'quoted') {
      if (dotAtom(t.v)) local.push(t.v);
      else {
        if (t.v.includes('@')) flags.suspicious = true;
        local.push('"' + t.v.replace(/["\\]/g, (m) => '\\' + m) + '"');
      }
    } else local.push(t.v);
  }
  if (!words) return null;
  const lp = local.join('');
  if (lp.includes('%') || lp.includes('!')) flags.suspicious = true;
  const ew = lp.indexOf('=?');
  if (ew >= 0 && lp.indexOf('?=', ew + 2) >= 0) flags.suspicious = true;
  // the domain: one literal, or atoms with single dots between
  const dom = toks.slice(at + 1);
  let domain: string;
  if (dom.length === 1 && dom[0]!.k === 'literal') {
    const v = dom[0]!.v;
    for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); if (control(c) || c === 0x40 || ws(c)) return null; }
    flags.suspicious = true;
    domain = '[' + v + ']';
  } else {
    const labels: string[] = [];
    for (let k = 0; k < dom.length; k++) {
      const t = dom[k]!, label = k % 2 === 0;
      if (label ? t.k !== 'atom' : !isSpecial(t, '.')) return null;
      if (label) labels.push(t.v);
    }
    if (dom.length % 2 === 0) return null;
    domain = labels.join('.');
    const ew = domain.indexOf('=?');
    if (ew >= 0 && domain.indexOf('?=', ew + 2) >= 0) return null;
    for (const l of labels) if (asciiLower(l).startsWith('xn--') && !aLabelOk(l)) return null;
    if (!hostOk(domain)) return null;
  }
  return lp + '@' + domain;
}

/** a route's tokens, `@a,@b` (commas and empty elements allowed, RFC 5322's obs-domain-list) */
function routeOk(toks: readonly Tok[]): boolean {
  let seen = false;
  for (let k = 0; k < toks.length;) {
    if (isSpecial(toks[k], ',')) { k++; continue; }
    if (!isSpecial(toks[k], '@')) return false;
    let j = k + 1;
    while (j < toks.length && !isSpecial(toks[j], ',')) j++;
    const dom = toks.slice(k + 1, j);
    if (!dom.length || dom.length % 2 === 0) return false;
    for (let d = 0; d < dom.length; d++) if (d % 2 === 0 ? dom[d]!.k !== 'atom' || dom[d]!.bad : !isSpecial(dom[d], '.')) return false;
    seen = true;
    k = j;
  }
  return seen;
}

/** a comment's text, or a phrase's pieces, decoded and cleaned; empty is null */
function decoded(text: string | Piece[], sink: Sink, budget: WordBudget): string | null {
  const s = (typeof text === 'string' ? decodeWords(text, sink, budget, PHRASE_WORDS) : joinPieces(text, sink, budget, PHRASE_WORDS)).trim();
  return s || null;
}

/** whether the name is the address itself: ASCII case-insensitive, quotes around it aside */
function isItself(name: string, address: string | null): boolean {
  if (address === null) return false;
  let s = 0, e = name.length;
  const q = (c: number) => c === 0x22 || c === 0x27 || ws(c);
  while (s < e && q(name.charCodeAt(s))) s++;
  while (e > s && q(name.charCodeAt(e - 1))) e--;
  return asciiLower(name.slice(s, e)) === asciiLower(address);
}

/** a display name holding `@` or `<`, or a character NFKC makes one (`＠`, `﹫`, `＜`, `﹤`) */
function looksLikeAddress(name: string): boolean {
  const has = (s: string) => s.includes('@') || s.includes('<');
  return has(name) || has(name.normalize('NFKC'));
}

/** one mailbox's tokens (between separators) read, or null when they are only whitespace and comments */
function mailbox(toks: readonly Tok[], sink: Sink, budget: WordBudget): Address | null {
  const flags = { suspicious: false };
  let badComment = false;
  const plain: Tok[] = [];
  let firstComment: string | null = null;
  for (const t of toks) {
    if (t.k === 'comment') { if (t.bad) badComment = true; else if (firstComment === null && t.v.trim()) firstComment = t.v; }
    else plain.push(t);
  }
  if (!plain.length && !badComment) return null;
  let name: string | null = null, address: string | null = null;
  const lt = plain.findIndex((t) => isSpecial(t, '<'));
  if (lt >= 0) {
    // name-addr: [display-name] "<" [route ":"] addr-spec ">", only comments after it
    const gt = plain.findIndex((t) => isSpecial(t, '>'));
    const display = phrase(toks.slice(0, toks.indexOf(plain[lt]!)));
    name = decoded(display.pieces, sink, budget);
    const pair = plain.filter((t) => isSpecial(t, '<') || isSpecial(t, '>')).length === 2;
    if (display.valid && pair && gt === plain.length - 1 && gt > lt) {
      let inner = plain.slice(lt + 1, gt);
      const colon = inner.findIndex((t) => isSpecial(t, ':'));
      let routed = true;
      if (colon >= 0) {
        routed = routeOk(inner.slice(0, colon));
        flags.suspicious = true;
        inner = inner.slice(colon + 1);
      }
      if (routed && !inner.some((t) => isSpecial(t, ':'))) address = addrSpec(inner, flags);
    }
    if (name === null && firstComment !== null && address !== null) name = decoded(firstComment, sink, budget);
  } else if (plain.some((t) => isSpecial(t, '@'))) {
    address = addrSpec(plain, flags);
    if (firstComment !== null) name = decoded(firstComment, sink, budget);
  } else {
    // words only: not a mailbox (`undisclosed-recipients` without its `:;`)
    name = decoded(phrase(plain).pieces, sink, budget);
  }
  if (badComment) address = null;
  if (address === null) sink('address-ambiguous');
  const out: Address = { name, address };
  if (flags.suspicious || (name !== null && looksLikeAddress(name) && !isItself(name, address))) out.suspicious = true;
  return out;
}

/**
 * The addresses of an address field's raw value (From, To, Cc, Reply-To, Sender, …), in order. A group's members
 * carry its name in `group`; an empty group is one Address with `name` and `address` null. A group name is
 * `suspicious` by the display name's rule, and so is each member. A group phrase the grammar cannot read
 * (`alice@example.org:<bob@example.org>`) is one Address with that name and `address: null`, and every member up
 * to its `;` (or the end) is `address: null` too. A `;` with no group open separates, and makes the mailboxes on
 * both sides of it `address: null` (`alice@example.org;<bob@example.org>`, Python's CVE-2023-27043). At most
 * `MAX_ADDRESSES`; past them `field-dropped`. Problems: `address-ambiguous` (once), `field-dropped`, and the
 * encoded words' (`charset-unknown`, …).
 */
export function addresses(raw: string, sink: Sink): Address[] {
  const report = once(sink);
  const budget = fieldBudget();
  const toks = tokenize(raw);
  const out: Address[] = [];
  let seg: Tok[] = [], inAngle = false, group: string | null = null, members = 0, full = false;
  // the open group's phrase could not be read; the segment after a stray `;` is nulled
  let badGroup = false, groupSuspicious = false, strayRight = false;
  const push = (a: Address) => {
    if (out.length >= MAX_ADDRESSES) { if (!full) { full = true; report('field-dropped'); } return; }
    out.push(a);
  };
  const emptyGroup = (g: string) => {
    const a: Address = { name: null, address: null, group: g };
    if (looksLikeAddress(g)) a.suspicious = true;
    push(a);
  };
  const end = (strayLeft: boolean) => {
    const nulled = strayLeft || strayRight || (group !== null && badGroup);
    strayRight = false;
    const a = mailbox(seg, report, budget);
    seg = [];
    if (!a) return;
    if (nulled && a.address !== null) { a.address = null; report('address-ambiguous'); }
    if (group !== null) {
      a.group = group;
      members++;
      if (groupSuspicious && !isItself(group, a.address)) a.suspicious = true;
    }
    push(a);
  };
  for (let k = 0; k < toks.length && !full; k++) {
    const t = toks[k]!;
    if (t.k === 'special' && !inAngle) {
      if (t.v === ',') { end(false); continue; }
      if (t.v === ';') {
        const stray = group === null;
        end(stray);
        if (stray) strayRight = true;
        else { if (!members) emptyGroup(group!); group = null; badGroup = false; }
        continue;
      }
      if (t.v === ':' && group === null) {
        const p = phrase(seg);
        group = joinPieces(p.pieces, report, budget, PHRASE_WORDS).trim();
        badGroup = !p.valid;
        groupSuspicious = looksLikeAddress(group);
        if (badGroup) {
          report('address-ambiguous');
          const a: Address = { name: group || null, address: null };
          if (groupSuspicious) a.suspicious = true;
          push(a);
        }
        members = 0;
        seg = [];
        continue;
      }
    }
    if (isSpecial(t, '<')) inAngle = true;
    else if (isSpecial(t, '>')) inAngle = false;
    seg.push(t);
  }
  if (!full) {
    end(false);
    if (group !== null && !members) emptyGroup(group);
  }
  return out;
}

/**
 * The form two addresses compare by (section 6, RFC 9788 4.4.5): the local part ASCII-lowercased, the domain as
 * lowercase A-labels (a domain literal ASCII-lowercased). Null for null, or a domain URL cannot read.
 */
export function addressKey(address: string | null): string | null {
  if (address === null) return null;
  const at = address.lastIndexOf('@');
  if (at <= 0) return null;
  const domain = address.slice(at + 1);
  let host: string;
  if (domain.startsWith('[')) host = asciiLower(domain);
  else {
    if (!hostOk(domain)) return null;
    host = new URL('http://' + domain).hostname;
  }
  return asciiLower(address.slice(0, at)) + '@' + host;
}

/** whether two addr-specs are the same address (`addressKey`); null never matches, not even null */
export function sameAddress(a: string | null, b: string | null): boolean {
  const x = addressKey(a);
  return x !== null && x === addressKey(b);
}
