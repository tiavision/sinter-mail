// Header blocks and the fields of them that are not addresses or dates (docs/proposals/sinter-mail-mime.md,
// sections 3 and 4): the block read from bytes, encoded words (RFC 2047), the removal of controls, parameter
// fields (Content-Type, Content-Disposition, with RFC 2231) and Message-ID lists.
//
// Structure is read before anything is decoded: a parameter's name, a token and an id are never decoded, and an
// encoded word is decoded only where it can only be text (unstructured fields, phrases, comments, and the
// `filename`/`name` values Outlook and Gmail encode against the standard). A decoded `"`, `;`, `<` or line break is
// then text, never structure (Mailsploit, "Splitting the email atom"). Every scanner here is one pass with no
// backtracking: hostile input costs time linear in its length.
import { asciiLower, decodeText, supported } from './charset.js';
import { base64, once, type Sink } from './decode.js';

/** a root's header block, in bytes: long recipient lists, `Received`, ARC and Microsoft headers */
export const ROOT_HEADER_BYTES = 1 << 20;
/** a part's header block, in bytes */
export const PART_HEADER_BYTES = 64 << 10;
/** fields in one header block */
export const MAX_FIELDS = 1_000;
/** encoded words in one phrase, and in one field */
export const PHRASE_WORDS = 64;
export const FIELD_WORDS = 4_096;

/** one field of a header block */
export interface RawField {
  /** the field name, ASCII-lowercased */
  name: string;
  /** the value unfolded (line ends before whitespace removed), leading and trailing whitespace trimmed; bytes read
   * as UTF-8 (RFC 6532), windows-1252 when invalid; not decoded otherwise, controls kept */
  value: string;
  /** offset of the field's first byte */
  start: number;
  /** offset just past the line end of its last line (or the block's end) */
  end: number;
}

export interface HeaderBlock {
  /** the fields kept, in order */
  fields: RawField[];
  /** whether a blank line ended the block; false: it ran to the end (the caller reports `no-header-end`) */
  ended: boolean;
  /** the offset just past the blank line, or the range's end */
  bodyStart: number;
}

const isWsp = (c: number) => c === 0x20 || c === 0x09;

/**
 * The header block at `src[start, end)`. A line ends at CRLF or a bare LF (a bare CR is a character); a line that
 * starts with a space or tab continues the field before it; only an empty line ends the block. Fields past
 * `MAX_FIELDS`, or reaching past the block's size limit (`ROOT_HEADER_BYTES` with `root`, else
 * `PART_HEADER_BYTES`), are dropped with the rest of the block (`field-dropped`), which is still read to its end.
 *
 * Malformed lines have one reading each, and are `header-malformed` (once per block): a line with no colon, or a
 * name that is not printable ASCII, is skipped; whitespace before the colon is accepted, the name trimmed; a
 * continuation with no field before it is dropped; a line of only whitespace continues the field (obs-FWS) and
 * does not end the block. A control character in a field name (the line skipped) or in MIME-Version's value is
 * `control-in-structure`.
 */
export function readHeaders(src: Uint8Array, start: number, end: number, root: boolean, sink: Sink): HeaderBlock {
  const limit = root ? ROOT_HEADER_BYTES : PART_HEADER_BYTES;
  const report = once(sink);
  const fields: RawField[] = [];
  let dropping = false, first = true;
  // the field being read: its start, its lines' content ranges, its end, its name
  let cur: { start: number; segs: number[]; end: number; name: string } | null = null;
  const drop = () => { if (!dropping) { dropping = true; report('field-dropped'); } cur = null; };
  const finish = () => {
    if (!cur) return;
    if (fields.length >= MAX_FIELDS) { drop(); return; }
    let size = 0;
    for (let k = 0; k < cur.segs.length; k += 2) size += cur.segs[k + 1]! - cur.segs[k]!;
    const bytes = new Uint8Array(size);
    for (let k = 0, n = 0; k < cur.segs.length; k += 2) { bytes.set(src.subarray(cur.segs[k]!, cur.segs[k + 1]!), n); n += cur.segs[k + 1]! - cur.segs[k]!; }
    let s = 0, e = bytes.length;
    while (s < e && isWsp(bytes[s]!)) s++;
    while (e > s && isWsp(bytes[e - 1]!)) e--;
    const value = decodeText(bytes.subarray(s, e), null, report);
    if (cur.name === 'mime-version' && hasControl(value)) report('control-in-structure');
    fields.push({ name: cur.name, value, start: cur.start, end: cur.end });
    cur = null;
  };
  for (let pos = start; pos < end; first = false) {
    let lf = pos;
    while (lf < end && src[lf] !== 0x0a) lf++;
    const content = lf < end && lf > pos && src[lf - 1] === 0x0d ? lf - 1 : lf;
    const next = lf < end ? lf + 1 : end;
    if (content === pos) {
      finish();
      return { fields, ended: true, bodyStart: next };
    }
    const continued = isWsp(src[pos]!);
    if (!continued) finish();
    if (!dropping && next - start > limit) drop();
    if (continued) {
      let blank = true;
      for (let k = pos; k < content && blank; k++) blank = isWsp(src[k]!);
      if (blank || first) report('header-malformed');
      if (cur) { cur.segs.push(pos, content); cur.end = next; }
    } else if (!dropping) {
      // the name: up to the colon or whitespace
      let i = pos, control = false, printable = true;
      for (; i < content; i++) {
        const c = src[i]!;
        if (c === 0x3a || isWsp(c)) break;
        if (c < 0x20 || c === 0x7f) control = true;
        else if (c > 0x7e) printable = false;
      }
      let colon = i;
      while (colon < content && isWsp(src[colon]!)) colon++;
      if (control) report('control-in-structure');
      if (i === pos || control || !printable || colon >= content || src[colon] !== 0x3a) report('header-malformed');
      else {
        if (colon > i) report('header-malformed');
        let name = '';
        for (let k = pos; k < i; k++) name += String.fromCharCode(src[k]!);
        cur = { start: pos, segs: [colon + 1, content], end: next, name: asciiLower(name) };
      }
    }
    pos = next;
  }
  finish();
  return { fields, ended: false, bodyStart: end };
}

/** NUL, C0 controls but tab, CR, LF, DEL and the bidirectional controls */
const CONTROLS = /[\u0000-\u0008\u000a-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;

/**
 * A decoded value made safe to show and to reuse in a header: NUL, C0 controls, CR, LF, DEL and every
 * bidirectional control (U+200E, U+200F, U+061C, U+202A to U+202E, U+2066 to U+2069) removed, and a tab made a
 * space (folding leaves tabs between words).
 */
export function clean(s: string): string {
  return s.replace(CONTROLS, '').replace(/\t/g, ' ');
}

/** encoded words still allowed in one field: one per field, passed to each call that decodes part of it */
export interface WordBudget { words: number }

export const fieldBudget = (): WordBudget => ({ words: FIELD_WORDS });

/** RFC 2047's especials, which a charset token cannot hold */
const especial = (c: number) => c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x40 || c === 0x2c || c === 0x3b
  || c === 0x3a || c === 0x22 || c === 0x2f || c === 0x5b || c === 0x5d || c === 0x3f || c === 0x2e || c === 0x3d || c === 0x5c;

/** an encoded word, read but not decoded: its text as sent, its charset (lowercased, language dropped), its payload */
export interface Word { raw: string; end: number; charset: string; b: boolean; payload: Uint8Array }

/** text to decode: literal strings and encoded words, in order */
export type Piece = string | Word;

/** the encoded word `=?charset?B|Q?text?=` at `text[at]`, or null; it reads at most up to the third `?` after `at` */
function encodedWord(text: string, at: number): Word | null {
  let i = at + 2;
  const cs = i;
  while (i < text.length && i - cs <= 64) {
    const c = text.charCodeAt(i);
    if (c === 0x3f || c <= 0x20 || c >= 0x7f || especial(c)) break;
    i++;
  }
  if (i === cs || text.charCodeAt(i) !== 0x3f) return null;
  const enc = text.charCodeAt(i + 1) | 0x20;
  if ((enc !== 0x62 && enc !== 0x71) || text.charCodeAt(i + 2) !== 0x3f) return null;
  const ps = i + 3;
  let j = ps;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === 0x3f || c <= 0x20 || c >= 0x7f) break;
    j++;
  }
  if (text.charCodeAt(j) !== 0x3f || text.charCodeAt(j + 1) !== 0x3d) return null;
  let charset = text.slice(cs, i);
  const star = charset.indexOf('*');   // RFC 2231's language suffix, `utf-8*en`
  if (star >= 0) charset = charset.slice(0, star);
  const raw = new Uint8Array(j - ps);
  for (let k = ps; k < j; k++) raw[k - ps] = text.charCodeAt(k);
  return { raw: text.slice(at, j + 2), end: j + 2, charset: asciiLower(charset), b: enc === 0x62, payload: raw };
}

const hexValue = (c: number) =>
  c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;

/** RFC 2047's Q: `_` a space, `=` and two hex digits a byte, any other `=` kept (`qp-invalid`) */
function qDecode(raw: Uint8Array, sink: Sink): Uint8Array {
  const out = new Uint8Array(raw.length);
  let n = 0, bad = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === 0x5f) out[n++] = 0x20;
    else if (c === 0x3d) {
      const hi = i + 2 < raw.length ? hexValue(raw[i + 1]!) : -1, lo = hi >= 0 ? hexValue(raw[i + 2]!) : -1;
      if (lo >= 0) { out[n++] = (hi << 4) | lo; i += 2; } else { out[n++] = c; bad = true; }
    } else out[n++] = c;
  }
  if (bad) sink('qp-invalid');
  return out.subarray(0, n);
}

const wsAt = (s: string, i: number) => { const c = s.charCodeAt(i); return c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a; };

const blankText = (s: string) => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c !== 0x20 && c !== 0x09 && c !== 0x0d && c !== 0x0a) return false; } return true; };

/**
 * `text` as pieces: an encoded word counts only as a whole word, with whitespace or the text's ends around it; one
 * glued to other characters (`collab=?x?b?QA==?=psres.net`, `=?a?q?b?==?a?q?c?=`) stays literal. For unstructured
 * text, a comment's text, a quoted string's content (Outlook encodes inside quotes) and a parameter value.
 */
export function wordsIn(text: string): Piece[] {
  const out: Piece[] = [];
  let lit = 0;
  for (let i = 0; ;) {
    const at = text.indexOf('=?', i);
    if (at < 0) break;
    const w = encodedWord(text, at);
    if (!w || (at > 0 && !wsAt(text, at - 1)) || (w.end < text.length && !wsAt(text, w.end))) { i = at + 1; continue; }
    if (at > lit) out.push(text.slice(lit, at));
    out.push(w);
    i = lit = w.end;
  }
  if (lit < text.length) out.push(text.slice(lit));
  return out;
}

/** an atom of a tokenized phrase as pieces: one encoded word when it is the whole atom, else literal */
export function atomPieces(atom: string): Piece[] {
  const w = atom.startsWith('=?') ? encodedWord(atom, 0) : null;
  return [w && w.end === atom.length ? w : atom];
}

/** whether `text` holds an encoded word by `wordsIn`'s rule */
export function hasEncodedWord(text: string): boolean {
  return wordsIn(text).some((p) => typeof p !== 'string');
}

/**
 * The pieces decoded and joined, then `clean`ed. Encoded words separated only by whitespace are joined without it;
 * consecutive words of one charset are joined into one buffer and decoded once (`decodeText`'s table and
 * problems), so a character split across two words comes out whole and the work is linear. A word in a charset this
 * runtime cannot decode stays as written (`charset-unknown`; RFC 2047, 6.2). At most `cap` words here and
 * `budget.words` in the field: past either, the rest is dropped (`field-dropped`).
 */
export function joinPieces(pieces: readonly Piece[], sink: Sink, budget: WordBudget = fieldBudget(), cap = FIELD_WORDS): string {
  const out: string[] = [];
  let gap: string[] = [], prevWord = false, count = 0, dropped = false;
  let charset: string | null = null, chunks: Uint8Array[] = [];
  const flush = () => {
    if (charset === null) return;
    let size = 0;
    for (const c of chunks) size += c.length;
    const all = new Uint8Array(size);
    for (let k = 0, n = 0; k < chunks.length; k++) { all.set(chunks[k]!, n); n += chunks[k]!.length; }
    out.push(decodeText(all, charset, sink));
    charset = null; chunks = [];
  };
  const literal = (s: string) => { flush(); out.push(...gap, s); gap = []; prevWord = false; };
  // charsets looked up here: a hostile text repeats a label many times
  const known = new Map<string, boolean>();
  for (const p of pieces) {
    if (typeof p === 'string') {
      if (prevWord && blankText(p)) gap.push(p);
      else literal(p);
      continue;
    }
    if (count >= cap || budget.words <= 0) { dropped = true; sink('field-dropped'); break; }
    count++; budget.words--;
    let ok = known.get(p.charset);
    if (ok === undefined) known.set(p.charset, ok = supported(p.charset));
    if (!ok) { sink('charset-unknown'); literal(p.raw); continue; }
    const bytes = p.b ? base64(p.payload, 0, p.payload.length, sink) : qDecode(p.payload, sink);
    if (prevWord) { gap = []; if (charset !== p.charset) flush(); }
    if (charset === null) charset = p.charset;
    chunks.push(bytes);
    prevWord = true;
  }
  flush();
  if (!dropped) out.push(...gap);
  return clean(out.join(''));
}

/** `text` with its encoded words (by `wordsIn`) decoded and joined by `joinPieces`, then `clean`ed */
export function decodeWords(text: string, sink: Sink, budget: WordBudget = fieldBudget(), cap = FIELD_WORDS): string {
  return joinPieces(wordsIn(text), sink, budget, cap);
}

/** an unstructured field (Subject, Comments, …): its encoded words decoded, controls removed */
export function unstructured(raw: string, sink: Sink): string {
  return decodeWords(raw, sink, fieldBudget(), FIELD_WORDS);
}

// --- parameter fields ---

/** a Content-Type or Content-Disposition field, read */
export interface ParameterField {
  /** `type/subtype` or the disposition token, ASCII-lowercased; '' when it is missing or not of that syntax */
  value: string;
  /** in order of first appearance; RFC 2231 forms under the name with `*` (`filename*`), joined and decoded */
  params: [name: string, value: string][];
  /** names (as in `params`) whose value held an encoded word: decoded in `filename` and `name`, literal elsewhere
   * (`encoded-word-in-parameter`; the caller makes it blocking for `boundary`) */
  encoded: string[];
  /** base names (`filename`, `charset`) sent in forms whose values differ: `x` beside `x*`, or two spellings
   * differing in case (`parameter-conflict`); the RFC 2231 form, then the first, wins */
  conflicts: string[];
}

/** parameters whose repetition is a blocking problem (section 2, `duplicate-parameter`) */
const WATCHED = new Set(['boundary', 'charset', 'protocol', 'filename', 'name', 'start', 'type', 'micalg']);

/** RFC 2045's tspecials, controls and space end a token */
const tokenChar = (c: number) => c > 0x20 && c < 0x7f && !(c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x40
  || c === 0x2c || c === 0x3b || c === 0x3a || c === 0x5c || c === 0x22 || c === 0x2f || c === 0x5b || c === 0x5d || c === 0x3f || c === 0x3d)
  || c >= 0x80;

/** NUL and the C0 controls but tab, and DEL */
const STRUCTURE_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/**
 * Whether a structural field's raw value (Content-Type, Content-Transfer-Encoding, Content-Disposition) holds NUL
 * or another control character but tab: parsers differ on where such a value ends, so the caller reports
 * `control-in-structure` (parameterField does).
 */
export function hasControl(raw: string): boolean {
  return STRUCTURE_CONTROL.test(raw);
}

/** a scanner over one field's value: whitespace, comments (nesting counted, not recursed), quoted strings */
class Scan {
  i = 0;
  constructor(readonly s: string) {}
  get done() { return this.i >= this.s.length; }
  at(): number { return this.s.charCodeAt(this.i); }
  /** whitespace and comments */
  cfws(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) this.i++;
      else if (c === 0x28) this.comment();
      else break;
    }
  }
  /** a comment, at `(`; an unterminated one runs to the end */
  comment(): void {
    const s = this.s;
    let depth = 0;
    for (; this.i < s.length; this.i++) {
      const c = s.charCodeAt(this.i);
      if (c === 0x5c) this.i++;
      else if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) { this.i++; return; }
    }
  }
  /** a quoted string's content, unescaped, at `"`; an unterminated one runs to the end */
  quoted(): string {
    const s = this.s, parts: string[] = [];
    let from = ++this.i;
    for (; this.i < s.length; this.i++) {
      const c = s.charCodeAt(this.i);
      if (c === 0x5c && this.i + 1 < s.length) { parts.push(s.slice(from, this.i)); from = ++this.i; }
      else if (c === 0x22) { parts.push(s.slice(from, this.i)); this.i++; return parts.join(''); }
    }
    parts.push(s.slice(from));
    return parts.join('');
  }
  token(): string {
    const from = this.i;
    while (this.i < this.s.length && tokenChar(this.s.charCodeAt(this.i))) this.i++;
    return this.s.slice(from, this.i);
  }
  /** to the next `;` outside a quoted string or a comment, or the end */
  skipToSemicolon(): void {
    while (this.i < this.s.length) {
      const c = this.at();
      if (c === 0x3b) return;
      if (c === 0x22) this.quoted();
      else if (c === 0x28) this.comment();
      else this.i++;
    }
  }
}

interface RawParam { name: string; spelled: string; value: string; quoted: boolean }

/** the field's parameters as sent: names lowercased, values unquoted or read leniently to the next `;` */
function rawParams(sc: Scan): RawParam[] {
  const out: RawParam[] = [];
  const s = sc.s;
  while (!sc.done) {
    sc.skipToSemicolon();
    if (sc.done) break;
    sc.i++;
    sc.cfws();
    const from = sc.i;
    while (sc.i < s.length) {
      const c = sc.at();
      if (c === 0x3d || c === 0x3b || c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a || c === 0x28 || c === 0x22) break;
      sc.i++;
    }
    const spelled = s.slice(from, sc.i), name = asciiLower(spelled);
    sc.cfws();
    if (!name || sc.at() !== 0x3d) continue;
    sc.i++;
    sc.cfws();
    if (sc.at() === 0x22) { out.push({ name, spelled, value: sc.quoted(), quoted: true }); continue; }
    // unquoted: a token by the standard; leniently, words up to `;`, a comment between them dropped
    const parts: string[] = [];
    while (sc.i < s.length) {
      const w = sc.i;
      while (sc.i < s.length) {
        const c = sc.at();
        if (c === 0x3b || c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a || c === 0x28) break;
        sc.i++;
      }
      if (sc.i > w) parts.push(s.slice(w, sc.i));
      const ws = sc.i;
      while (sc.i < s.length && (sc.at() === 0x20 || sc.at() === 0x09 || sc.at() === 0x0d || sc.at() === 0x0a)) sc.i++;
      if (sc.done || sc.at() === 0x3b) break;
      if (sc.at() === 0x28) { sc.comment(); continue; }
      if (parts.length) parts.push(s.slice(ws, sc.i));
    }
    out.push({ name, spelled, value: parts.join(''), quoted: false });
  }
  return out;
}

/** `%XX` decoded to bytes, any other character (ASCII, as RFC 2231 requires; others as UTF-8) kept */
function percentBytes(s: string): Uint8Array {
  const enc = new TextEncoder().encode(s);
  const out = new Uint8Array(enc.length);
  let n = 0;
  for (let i = 0; i < enc.length; i++) {
    const c = enc[i]!;
    if (c === 0x25 && i + 2 < enc.length) {
      const hi = hexValue(enc[i + 1]!), lo = hexValue(enc[i + 2]!);
      if (hi >= 0 && lo >= 0) { out[n++] = (hi << 4) | lo; i += 2; continue; }
    }
    out[n++] = c;
  }
  return out.subarray(0, n);
}

interface Segment { section: number; extended: boolean; value: string }

/** RFC 2231's segments, ordered, joined and decoded; out of order, repeated or missing: `rfc2231-segments` */
function joinSegments(segs: Segment[], sink: Sink): string {
  let bad = false;
  for (let k = 1; k < segs.length; k++) if (segs[k]!.section <= segs[k - 1]!.section) bad = true;
  const sorted = segs.map((s, k) => [s, k] as const).sort((a, b) => a[0].section - b[0].section || a[1] - b[1]).map((x) => x[0]);
  const kept: Segment[] = [];
  for (const s of sorted) {
    if (kept.length && kept[kept.length - 1]!.section === s.section) { bad = true; continue; }
    kept.push(s);
  }
  if (kept[0]!.section !== 0 || kept[kept.length - 1]!.section !== kept.length - 1) bad = true;
  if (bad) sink('rfc2231-segments');
  // the charset is in the first segment, when it is section 0 and extended: charset'language'value
  let charset: string | null = null;
  const first = kept[0]!;
  if (first.section === 0 && first.extended) {
    const a = first.value.indexOf("'"), b = a >= 0 ? first.value.indexOf("'", a + 1) : -1;
    if (b >= 0) { charset = first.value.slice(0, a); kept[0] = { ...first, value: first.value.slice(b + 1) }; }
  }
  const out: string[] = [];
  for (let k = 0; k < kept.length;) {
    if (!kept[k]!.extended) { out.push(kept[k++]!.value); continue; }
    // a run of extended segments: one buffer, decoded once
    const run: Uint8Array[] = [];
    let size = 0;
    while (k < kept.length && kept[k]!.extended) { const b = percentBytes(kept[k++]!.value); run.push(b); size += b.length; }
    const all = new Uint8Array(size);
    for (let r = 0, n = 0; r < run.length; r++) { all.set(run[r]!, n); n += run[r]!.length; }
    out.push(decodeText(all, charset, sink));
  }
  return clean(out.join(''));
}

/**
 * A Content-Type or Content-Disposition value: its type (`type/subtype`, CFWS allowed around the `/`) or token,
 * then its parameters, read before anything in them is decoded. RFC 2231's forms (`name*=charset'lang'%XX`,
 * `name*0*=`, `name*1=`) are joined in section order and come out as `name*`. An RFC 2047 word in a value is
 * `encoded-word-in-parameter` and named in `encoded`: decoded in `filename` and `name` (at most 64 each), literal
 * in any other. Decoded values are `clean`ed; others (a boundary) are as sent. A repeated parameter: the first
 * counts (`duplicate-parameter` for boundary, charset, protocol, filename, name, start, type, micalg); forms of
 * one parameter with different values are `parameter-conflict`, named in `conflicts`. A control character in the
 * raw value is `control-in-structure`. The value is '' when it is not a token or `type/subtype` (see
 * `contentType` for Content-Type's default).
 */
export function parameterField(raw: string, sink: Sink): ParameterField {
  if (hasControl(raw)) sink('control-in-structure');
  const sc = new Scan(raw);
  sc.cfws();
  let value = sc.token();
  sc.cfws();
  if (sc.at() === 0x2f) {
    sc.i++;
    sc.cfws();
    const sub = sc.token();
    value = value && sub ? value + '/' + sub : '';
  }
  sc.cfws();
  if (!sc.done && sc.at() !== 0x3b) value = '';
  value = asciiLower(value);
  const budget = fieldBudget();
  // by output name: a plain value (and how its name was spelled), or RFC 2231's segments (a single `name*` is
  // section 0)
  const order: string[] = [];
  const plain = new Map<string, { spelled: string; value: string }>();
  const ext = new Map<string, { single: boolean; segs: Segment[] }>();
  const conflicts = new Set<string>();
  const conflict = (base: string) => { sink('parameter-conflict'); conflicts.add(base); };
  const dup = (base: string) => { if (WATCHED.has(base)) sink('duplicate-parameter'); };
  for (const p of rawParams(sc)) {
    let name = p.name, extended = false, section = -1;
    if (name.endsWith('*')) { extended = true; name = name.slice(0, -1); }
    const star = name.lastIndexOf('*');
    if (star > 0 && star < name.length - 1 && name.length - star <= 4 && /^[0-9]+$/.test(name.slice(star + 1))) {
      section = Number(name.slice(star + 1));
      name = name.slice(0, star);
    } else if (extended) section = 0;
    if (section < 0) {
      const first = plain.get(name);
      if (first) {
        dup(name);
        if (first.spelled !== p.spelled && first.value !== p.value) conflict(name);
        continue;
      }
      plain.set(name, { spelled: p.spelled, value: p.value });
      order.push(name);
      continue;
    }
    const key = name + '*', single = extended && !/\*[0-9]+$/.test(p.name.slice(0, -1));
    const e = ext.get(key);
    if (!e) { ext.set(key, { single, segs: [{ section, extended, value: p.value }] }); order.push(key); continue; }
    // a single `name*=` beside segments, or a second single one: a repetition
    if (e.single || single) { dup(name); continue; }
    e.segs.push({ section, extended, value: p.value });
  }
  const params: [string, string][] = [], encoded: string[] = [];
  for (const key of order) {
    const e = ext.get(key);
    if (e) { params.push([key, joinSegments(e.segs, sink)]); continue; }
    const v = plain.get(key)!.value, pieces = wordsIn(v);
    if (pieces.some((x) => typeof x !== 'string')) { sink('encoded-word-in-parameter'); encoded.push(key); }
    params.push([key, key === 'filename' || key === 'name' ? joinPieces(pieces, sink, budget, PHRASE_WORDS) : v]);
  }
  // `x` beside `x*` with another value
  const byName = new Map(params);
  for (const [key, v] of params) {
    if (!key.endsWith('*')) continue;
    const base = key.slice(0, -1), other = byName.get(base);
    if (other !== undefined && other !== v) conflict(base);
  }
  return { value, params, encoded, conflicts: [...conflicts] };
}

/** RFC 2045's default, for a Content-Type that cannot be read */
const DEFAULT_TYPE = (): ParameterField => ({ value: 'text/plain', params: [['charset', 'us-ascii']], encoded: [], conflicts: [] });

/**
 * A Content-Type: `parameterField`, and when its value is not `type/subtype`, RFC 2045's default
 * `text/plain; charset=us-ascii` with `content-type-invalid`.
 */
export function contentType(raw: string, sink: Sink): ParameterField {
  const f = parameterField(raw, sink);
  if (f.value.includes('/')) return f;
  sink('content-type-invalid');
  return DEFAULT_TYPE();
}

/**
 * A Content-Transfer-Encoding: its token ASCII-lowercased, comments and whitespace around it removed; null when
 * the value is empty, quoted, or has anything after the token (the caller reports `encoding-unknown`). A control
 * character is `control-in-structure`.
 */
export function transferEncoding(raw: string, sink: Sink): string | null {
  if (hasControl(raw)) sink('control-in-structure');
  const sc = new Scan(raw);
  sc.cfws();
  const token = sc.token();
  sc.cfws();
  return token && sc.done ? asciiLower(token) : null;
}

/** the value of parameter `name` in `params`, or null */
export function param(params: readonly (readonly [string, string])[], name: string): string | null {
  for (const [n, v] of params) if (n === name) return v;
  return null;
}

// --- Message-ID lists ---

/**
 * The ids of a Message-ID, In-Reply-To or References value, in order, without their angle brackets, whitespace
 * and controls removed from each; comments and phrases (old In-Reply-To values) skipped. A value with no `<…>`
 * that is one word holding `@` is that id.
 */
export function messageIds(raw: string): string[] {
  const sc = new Scan(raw), ids: string[] = [], s = raw;
  while (true) {
    sc.cfws();
    if (sc.done) break;
    const c = sc.at();
    if (c === 0x3c) {
      const from = ++sc.i;
      while (sc.i < s.length && sc.at() !== 0x3e && sc.at() !== 0x3c) sc.i++;
      const id = clean(s.slice(from, sc.i)).replace(/[ ]+/g, '');
      if (sc.at() === 0x3e) sc.i++;
      if (id) ids.push(id);
    } else if (c === 0x22) sc.quoted();
    else sc.i++;
  }
  if (!ids.length) {
    const sc2 = new Scan(raw);
    sc2.cfws();
    const from = sc2.i;
    while (!sc2.done && !(sc2.at() === 0x20 || sc2.at() === 0x09 || sc2.at() === 0x0d || sc2.at() === 0x0a || sc2.at() === 0x28)) sc2.i++;
    const word = s.slice(from, sc2.i);
    sc2.cfws();
    if (sc2.done && word.includes('@')) ids.push(clean(word));
  }
  return ids;
}
