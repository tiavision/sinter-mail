// The transfer decoders (base64, quoted-printable) over a byte range, and the canonical line ends of signed bytes
// (docs/proposals/sinter-mail-mime.md, sections 3 and 5). mail.bytes imports this module relatively and nothing
// else of the reader, so it stays small and an ordinary helper.
//
// Each decoder is one pass into a buffer as large as its input: a decoder's output is never larger than its
// input, so hostile input cannot make it allocate more than it was given. Malformed input never throws: what was
// repaired is reported through the sink, once per call whatever the number of repairs (the caller attaches the
// part id, and a part has one problem of each code, not one per byte).
import type { ProblemCode, Ref } from './types.js';

/** where a reader reports what it repaired or refused; the caller attaches the part */
export type Sink = (code: ProblemCode) => void;

/** a sink that drops everything, for callers that do not ask */
export const ignore: Sink = () => {};

/** each code reported at most once by one decoding */
export function once(sink: Sink): Sink {
  const seen = new Set<ProblemCode>();
  return (code) => { if (!seen.has(code)) { seen.add(code); sink(code); } };
}

/** base64's alphabet, by byte: the six bits, or -1 outside it */
const B64 = new Int8Array(256).fill(-1);
for (let i = 0; i < 64; i++) B64['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;

/** whitespace and line ends: skipped silently in base64 */
const space = (c: number) => c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;

/** what base64 decoding found besides its bytes */
export interface Base64Result {
  bytes: Uint8Array;
  /** padding with more base64 after it (concatenated chunks): also `base64-junk`, told apart because the caller
   * makes it blocking under a signature */
  midPadding: boolean;
}

/** base64's bytes (`base64Result` without its flags) */
export function base64(src: Uint8Array, start: number, end: number, sink: Sink = ignore): Uint8Array {
  return base64Result(src, start, end, sink).bytes;
}

/**
 * Base64 (RFC 2045, 6.8) of `src[start, end)`. Whitespace is skipped; any other character outside the alphabet is
 * skipped and is `base64-junk`. Decoding is per quantum: padding ends its quantum, and decoding continues after it
 * (concatenated chunks), which is `base64-junk` unless only whitespace follows; a final partial quantum, or a
 * quantum padded with too few or too many `=`, is dropped or read as its padding says, and is `base64-junk`.
 */
export function base64Result(src: Uint8Array, start: number, end: number, sink: Sink = ignore): Base64Result {
  const report = once(sink);
  let midPadding = false;
  const out = new Uint8Array(Math.max(0, Math.ceil((end - start) * 3 / 4)));
  let n = 0, q = 0, bits = 0;
  for (let i = start; i < end; i++) {
    const c = src[i]!;
    const v = B64[c]!;
    if (v >= 0) {
      bits = (bits << 6) | v;
      if (++q === 4) {
        out[n++] = bits >>> 16; out[n++] = (bits >>> 8) & 255; out[n++] = bits & 255;
        q = 0; bits = 0;
      }
    } else if (c === 0x3d) {
      // `=`: the padding of the quantum read so far; then the run of `=` and whitespace that is that padding
      let pads = 1;
      while (i + 1 < end && (src[i + 1] === 0x3d || space(src[i + 1]!))) if (src[++i] === 0x3d) pads++;
      if (q === 2) out[n++] = bits >>> 4;
      else if (q === 3) { out[n++] = bits >>> 10; out[n++] = (bits >>> 2) & 255; }
      // padding with no quantum, after one character, or not as long as the quantum needs
      if (q < 2 || pads !== 4 - q) report('base64-junk');
      // padding in the middle: the chunk after it is decoded too
      if (i + 1 < end) { report('base64-junk'); midPadding = true; }
      q = 0; bits = 0;
    } else if (!space(c)) report('base64-junk');
  }
  if (q) report('base64-junk');
  return { bytes: out.slice(0, n), midPadding };
}

const hexValue = (c: number) =>
  c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;

/**
 * Quoted-printable (RFC 2045, 6.7) of `src[start, end)`, line by line (CRLF or bare LF ends a line; a bare CR is a
 * character). Whitespace at the end of each encoded line is removed, before its soft break `=` is looked for, so
 * whitespace before `=` is content (`hello =\r\nworld` is `hello world`). `=` and two hex digits (either case) is
 * a byte; `=` not followed by two hex digits (a bare CR included) is kept as it is, and is `qp-invalid`; `=` as
 * the last byte (whitespace aside) is dropped, and is `qp-invalid`. A hard line end is kept as sent.
 */
export function quotedPrintable(src: Uint8Array, start: number, end: number, sink: Sink = ignore): Uint8Array {
  const report = once(sink);
  const out = new Uint8Array(Math.max(0, end - start));
  let n = 0;
  for (let line = start; line < end;) {
    // the line's content [line, stop) and its line end [stop, next)
    let next = line;
    while (next < end && src[next] !== 0x0a) next++;
    let stop = next;
    if (next < end) { next++; if (stop > line && src[stop - 1] === 0x0d) stop--; }
    let last = stop;
    while (last > line && (src[last - 1] === 0x20 || src[last - 1] === 0x09)) last--;
    const soft = last > line && src[last - 1] === 0x3d;
    if (soft) last--;
    // `=` (and whitespace) as the input's last bytes: a soft break with no line after it, dropped
    if (soft && next === stop) report('qp-invalid');
    for (let i = line; i < last; i++) {
      const c = src[i]!;
      if (c === 0x3d) {
        // both digits on this line's content
        const hi = i + 2 < last ? hexValue(src[i + 1]!) : -1;
        const lo = hi >= 0 ? hexValue(src[i + 2]!) : -1;
        if (lo >= 0) { out[n++] = (hi << 4) | lo; i += 2; continue; }
        report('qp-invalid');
      }
      out[n++] = c;
    }
    if (!soft) for (let i = stop; i < next; i++) out[n++] = src[i]!;
    line = next;
  }
  return out.slice(0, n);
}

/**
 * `src[start, end)` with the transfer encoding undone: what mail.bytes returns before `canonical` and `slice`.
 * `identity` is a copy.
 */
export function transferDecode(src: Uint8Array, start: number, end: number, encoding: Ref['encoding'], sink: Sink = ignore): Uint8Array {
  if (encoding === 'base64') return base64(src, start, end, sink);
  if (encoding === 'quoted-printable') return quotedPrintable(src, start, end, sink);
  return src.slice(start, end);
}

/** whether `src[start, end)` has a line feed not preceded by a carriage return */
export function hasBareLF(src: Uint8Array, start = 0, end = src.length): boolean {
  for (let i = start; i < end; i++) if (src[i] === 0x0a && (i === start || src[i - 1] !== 0x0d)) return true;
  return false;
}

/**
 * The bytes with every bare LF made CRLF and nothing else changed (a bare CR stays): the canonical form a
 * signature covers (RFC 3156). Always a new array, at most twice as long.
 */
export function canonicalize(bytes: Uint8Array): Uint8Array {
  let extra = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a && (i === 0 || bytes[i - 1] !== 0x0d)) extra++;
  const out = new Uint8Array(bytes.length + extra);
  for (let i = 0, n = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (c === 0x0a && (i === 0 || bytes[i - 1] !== 0x0d)) out[n++] = 0x0d;
    out[n++] = c;
  }
  return out;
}
