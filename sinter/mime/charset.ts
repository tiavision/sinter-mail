// Bytes to text by a MIME charset label (docs/proposals/sinter-mail-mime.md, section 3, "Charsets"): WHATWG's
// labels through TextDecoder, the only charset tables the reader has. A missing label is UTF-8; UTF-8 that is not
// valid is read as windows-1252, what such a byte most often is; an unknown label, UTF-7 included (its escapes hide
// text from filters, and browsers dropped it), is read as a missing one. Never throws.
//
// windows-1252 and x-user-defined are decoded here rather than through TextDecoder: they are the fallback and a
// one-line mapping, and Node built without full ICU lacks some legacy decoders, which would make the fallback
// itself fail. Every other label that TextDecoder refuses in this runtime is `charset-unknown`.
import type { Sink } from './decode.js';

/** WHATWG's labels of the `replacement` encoding: TextDecoder refuses them; browsers decode them to one U+FFFD */
const REPLACEMENT = new Set(['csiso2022kr', 'hz-gb-2312', 'iso-2022-cn', 'iso-2022-cn-ext', 'iso-2022-kr', 'replacement']);

/** WHATWG's labels of windows-1252 */
const WINDOWS_1252 = new Set(['ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819', 'iso-8859-1', 'iso-ir-100',
  'iso8859-1', 'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'l1', 'latin1', 'us-ascii', 'windows-1252', 'x-cp1252']);

/** windows-1252's 0x80 to 0x9f; the rest of its bytes are their code points */
const CP1252_HIGH = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];

/** a label as WHATWG compares it: ASCII whitespace trimmed, ASCII lowercase */
export function normalizeLabel(label: string): string {
  let s = 0, e = label.length;
  const ws = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
  while (s < e && ws(label.charCodeAt(s))) s++;
  while (e > s && ws(label.charCodeAt(e - 1))) e--;
  return asciiLower(label.slice(s, e));
}

/** ASCII letters lowercased, nothing else changed (no locale, no Unicode case mapping) */
export function asciiLower(s: string): string {
  let upper = false;
  for (let i = 0; i < s.length && !upper; i++) { const c = s.charCodeAt(i); upper = c >= 0x41 && c <= 0x5a; }
  return upper ? s.replace(/[A-Z]+/g, (m) => m.toLowerCase()) : s;
}

/** windows-1252, by hand (WHATWG's mapping: 0x81, 0x8d, 0x8f, 0x90, 0x9d are their C1 code points) */
export function windows1252(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    const end = Math.min(bytes.length, i + 8192), codes = new Array<number>(end - i);
    for (let j = i; j < end; j++) { const b = bytes[j]!; codes[j - i] = b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80]! : b; }
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join('');
}

function userDefined(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    const end = Math.min(bytes.length, i + 8192), codes = new Array<number>(end - i);
    for (let j = i; j < end; j++) { const b = bytes[j]!; codes[j - i] = b < 0x80 ? b : 0xf780 + b - 0x80; }
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join('');
}

/** UTF-8, or windows-1252 with `charset-fallback` when it is not valid UTF-8; a leading BOM is dropped */
function utf8(bytes: Uint8Array, sink: Sink): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    sink('charset-fallback');
    return windows1252(bytes);
  }
}

const UTF8 = new Set(['', 'utf-8', 'utf8', 'unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'x-unicode20utf8']);

/**
 * Whether `label` names a charset this runtime decodes (WHATWG's labels that its TextDecoder has, and those decoded
 * here): an encoded word in any other is left as written (RFC 2047, 6.2). Missing or empty counts as UTF-8.
 */
export function supported(label: string | null | undefined): boolean {
  const l = label == null ? '' : normalizeLabel(label);
  if (UTF8.has(l) || WINDOWS_1252.has(l) || l === 'x-user-defined' || REPLACEMENT.has(l)) return true;
  try {
    new TextDecoder(l);
    return true;
  } catch {
    return false;
  }
}

/**
 * `bytes` as text in the charset `label` (a MIME `charset` parameter, an RFC 2047 or RFC 2231 charset): missing or
 * empty is UTF-8; invalid UTF-8 is windows-1252 (`charset-fallback`); an unknown label, UTF-7, or one this runtime's
 * TextDecoder lacks is read as missing (`charset-unknown`); WHATWG's replacement labels give one U+FFFD (none for
 * no bytes). Other labels decode as TextDecoder does, invalid sequences as U+FFFD.
 */
export function decodeText(bytes: Uint8Array, label: string | null | undefined, sink: Sink): string {
  const l = label == null ? '' : normalizeLabel(label);
  if (UTF8.has(l)) return utf8(bytes, sink);
  if (WINDOWS_1252.has(l)) return windows1252(bytes);
  if (l === 'x-user-defined') return userDefined(bytes);
  if (REPLACEMENT.has(l)) return bytes.length ? '�' : '';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(l);
  } catch {
    sink('charset-unknown');
    return utf8(bytes, sink);
  }
  return decoder.decode(bytes);
}
