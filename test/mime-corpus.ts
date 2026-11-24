// Test inputs for the MIME reader (docs/proposals/sinter-mail-mime.md): a loader for the fixture files in
// test/mime-corpus/, and deterministic generators for the inputs too large or too regular to keep as files.
// Every generator returns new bytes each call, the same bytes for the same arguments.
//
// What the reader must do with each input is in test/mime-corpus/hostile/manifest.json (`generators`).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORPUS_DIR = fileURLToPath(new URL('./mime-corpus/', import.meta.url));

export interface Fixture {
  /** path relative to the directory given to `corpus`, with `/` separators */
  name: string;
  path: string;
  bytes: Uint8Array;
}

/**
 * Every `.eml` file under `dir` (relative to test/mime-corpus/, or absolute), recursively, sorted by name,
 * read as bytes.
 */
export function corpus(dir = '.'): Fixture[] {
  const root = isAbsolute(dir) ? dir : resolve(CORPUS_DIR, dir);
  const out: Fixture[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d).sort()) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.eml')) {
        out.push({ name: relative(root, p).split(sep).join('/'), path: p, bytes: new Uint8Array(readFileSync(p)) });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A JSON file under test/mime-corpus/. */
export function corpusJson<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(resolve(CORPUS_DIR, name), 'utf8')) as T;
}

// --- building bytes ---

/** Bytes of a string whose code units are all below 256 (each one byte, as Latin-1). */
export function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) throw new RangeError(`latin1: U+${c.toString(16)} at ${i}`);
    out[i] = c;
  }
  return out;
}

function concat(chunks: (Uint8Array | string)[]): Uint8Array {
  const parts = chunks.map((c) => (typeof c === 'string' ? latin1(c) : c));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A line of `width` printable ASCII characters, the same for the same `n`. */
function line(n: number, width = 76): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';
  let s = '';
  let x = (n * 2654435761) >>> 0;
  for (let i = 0; i < width; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    s += alphabet[(x >>> 16) % alphabet.length];
  }
  return s.replace(/^ /, 'x').replace(/ $/, 'x');
}

const HEAD = 'From: Generator <generator@example.test>\r\nTo: reader@example.test\r\nDate: Tue, 24 Nov 2026 09:30:00 +0100\r\nMessage-ID: <generated@example.test>\r\nMIME-Version: 1.0\r\n';

const MiB = 1024 * 1024;

// --- size and count ---

/** One text/plain part whose body is exactly `bodyBytes` bytes (default 2 MiB) of 76-character CRLF lines. */
export function singlePart(bodyBytes = 2 * MiB): Uint8Array {
  const lines: string[] = [];
  let size = 0;
  for (let n = 0; size < bodyBytes; n++) {
    const l = line(n) + '\r\n';
    lines.push(l);
    size += l.length;
  }
  let body = lines.join('');
  body = body.slice(0, bodyBytes);
  return concat([HEAD, 'Subject: one large part\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\n', body]);
}

/** A flat multipart/mixed with `count` text/plain parts (default 20,000). */
export function manyParts(count = 20_000): Uint8Array {
  const chunks: string[] = [HEAD, `Subject: ${count} parts\r\nContent-Type: multipart/mixed; boundary="flat"\r\n\r\n`];
  for (let i = 1; i <= count; i++) chunks.push(`--flat\r\nContent-Type: text/plain\r\n\r\npart ${i}\r\n`);
  chunks.push('--flat--\r\n');
  return concat(chunks);
}

/** multipart/mixed nested `depth` levels deep (default 300), boundaries `d0` … `d{depth-1}`, text innermost. */
export function deepNesting(depth = 300): Uint8Array {
  // zero-padded, so no boundary is a prefix of another (`d1` would be of `d10`): only the depth limit is met
  const b = (i: number) => `nest-${String(i).padStart(4, '0')}`;
  const chunks: string[] = [HEAD, `Subject: nested ${depth} deep\r\nContent-Type: multipart/mixed; boundary="${b(0)}"\r\n\r\n`];
  for (let i = 1; i < depth; i++) chunks.push(`--${b(i - 1)}\r\nContent-Type: multipart/mixed; boundary="${b(i)}"\r\n\r\n`);
  chunks.push(`--${b(depth - 1)}\r\nContent-Type: text/plain\r\n\r\nthe innermost part\r\n`);
  for (let i = depth - 1; i >= 0; i--) chunks.push(`--${b(i)}--\r\n`);
  return concat(chunks);
}

/**
 * A root header block of at least `headerBytes` (default 2 MiB): From and To first, then folded `X-Pad`
 * fields of 4 KiB each (512 per 2 MiB, under the 1,000-field limit, so only the size limit is reached),
 * then Subject and Content-Type, which lie past the 1 MB limit.
 */
export function oversizedHeader(headerBytes = 2 * MiB): Uint8Array {
  const chunks: string[] = ['From: Generator <generator@example.test>\r\nTo: reader@example.test\r\n'];
  let size = chunks[0].length;
  for (let n = 0; size < headerBytes; n++) {
    let field = `X-Pad-${n}: ${line(n, 60)}`;
    for (let k = 1; field.length < 4096 - 80; k++) field += `\r\n ${line(n * 64 + k, 74)}`;
    field += '\r\n';
    chunks.push(field);
    size += field.length;
  }
  chunks.push('Subject: past the limit\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>body</p>\r\n');
  return concat(chunks);
}

/** A Subject of `count` encoded words (default 100,000), `=?utf-8?B?QUJD?=` (postal-mime GHSA-f2hq-32vh-53cc). */
export function manyEncodedWords(count = 100_000, word = '=?utf-8?B?QUJD?='): Uint8Array {
  const words: string[] = [];
  for (let i = 0; i < count; i++) words.push(word);
  // folded every 4 words, so no line exceeds 78 characters
  let value = '';
  for (let i = 0; i < count; i += 4) value += (i ? '\r\n ' : '') + words.slice(i, i + 4).join(' ');
  return concat([HEAD, `Subject: ${value}\r\nContent-Type: text/plain\r\n\r\nbody\r\n`]);
}

/** The same with words that each decode to invalid UTF-8 (`=?utf-8?B?gICA?=`, three 0x80 bytes). */
export function manyInvalidEncodedWords(count = 100_000): Uint8Array {
  return manyEncodedWords(count, '=?utf-8?B?gICA?=');
}

// --- boundaries ---

/**
 * A child's boundary that is a prefix of its parent's (`abc` inside `abcdef`). Legal: `--abcdef` is not a
 * delimiter of `abc` (section 3: `--boundaryX` is not `--boundary`). Prefix-matching readers split wrongly.
 */
export function boundaryPrefixOfParent(): Uint8Array {
  return concat([
    HEAD,
    'Subject: child boundary is a prefix of the parent\'s\r\nContent-Type: multipart/mixed; boundary="abcdef"\r\n\r\n',
    '--abcdef\r\nContent-Type: multipart/alternative; boundary="abc"\r\n\r\n',
    '--abc\r\nContent-Type: text/plain\r\n\r\nplain alternative\r\n',
    '--abc\r\nContent-Type: text/html\r\n\r\n<p>html alternative</p>\r\n',
    '--abc--\r\n',
    '--abcdef\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="note.txt"\r\n\r\nattached\r\n',
    '--abcdef--\r\n',
  ]);
}

/** A child's boundary that starts with its parent's (`abc-inner` inside `abc`): `boundary-invalid`. */
export function boundaryExtendsParent(): Uint8Array {
  return concat([
    HEAD,
    'Subject: child boundary starts with the parent\'s\r\nContent-Type: multipart/mixed; boundary="abc"\r\n\r\n',
    '--abc\r\nContent-Type: multipart/alternative; boundary="abc-inner"\r\n\r\n',
    '--abc-inner\r\nContent-Type: text/plain\r\n\r\nplain alternative\r\n',
    '--abc-inner\r\nContent-Type: text/html\r\n\r\n<p>html alternative</p>\r\n',
    '--abc-inner--\r\n',
    '--abc\r\nContent-Type: text/plain\r\n\r\nsecond part\r\n',
    '--abc--\r\n',
  ]);
}

/**
 * Missing close delimiters: the inner multipart/alternative is never closed (the outer delimiter ends it),
 * and the outer multipart/mixed runs to the end of the input.
 */
export function missingCloseBoundary(): Uint8Array {
  return concat([
    HEAD,
    'Subject: no close delimiters\r\nContent-Type: multipart/mixed; boundary="outer"\r\n\r\n',
    '--outer\r\nContent-Type: multipart/alternative; boundary="inner"\r\n\r\n',
    '--inner\r\nContent-Type: text/plain\r\n\r\nplain\r\n',
    '--inner\r\nContent-Type: text/html\r\n\r\n<p>html</p>\r\n',
    '--outer\r\nContent-Type: text/plain\r\n\r\nlast part, to the end of the input\r\n',
  ]);
}

/** Transport padding (spaces and tabs) after delimiters and the close delimiter: legal, no problem. */
export function transportPadding(): Uint8Array {
  return concat([
    HEAD,
    'Subject: transport padding\r\nContent-Type: multipart/mixed; boundary="pad"\r\n\r\n',
    'preamble\r\n',
    '--pad \t \r\nContent-Type: text/plain\r\n\r\nfirst\r\n',
    '--pad\t\r\nContent-Type: text/plain\r\n\r\nsecond\r\n',
    '--pad-- \t\r\n',
    'epilogue\r\n',
  ]);
}

/**
 * Line ends mixed: CRLF headers, an LF-only part, a part holding a bare CR (a character, not a line end), and a
 * `--mix\rX` line, which is no delimiter because the bare CR does not end the line.
 */
export function lineEndMix(): Uint8Array {
  return concat([
    HEAD,
    'Subject: mixed line ends\r\nContent-Type: multipart/mixed; boundary="mix"\r\n\r\n',
    '--mix\r\nContent-Type: text/plain\r\n\r\ncrlf one\r\ncrlf two\r\n',
    '--mix\nContent-Type: text/plain\n\nlf one\nlf two\n',
    '--mix\r\nContent-Type: text/plain\r\n\r\nbare\rcr\r\n--mix\rX not a delimiter\r\n',
    '--mix--\n',
  ]);
}

/**
 * base64 with characters outside the alphabet, padding mid-stream (concatenated chunks) and a final partial
 * quantum: decodes to `ABCDEFG` with `base64-junk` (section 3).
 */
export function base64Junk(): Uint8Array {
  return concat([
    HEAD,
    'Subject: base64 junk\r\nContent-Type: text/plain; charset=us-ascii\r\nContent-Transfer-Encoding: base64\r\n\r\n',
    'QUJD!RA==\r\nRU*ZH\r\nQ\r\n',
  ]);
}

// --- PGP/MIME shapes, placeholder armor (no real cryptography) ---

const ARMOR_MESSAGE =
  '-----BEGIN PGP MESSAGE-----\r\n\r\nhF4DAAAAAAAAAAASAQdAplaceholderplaceholderplaceholderplaceholder\r\n=AAAA\r\n-----END PGP MESSAGE-----\r\n';
const ARMOR_SIGNATURE =
  '-----BEGIN PGP SIGNATURE-----\r\n\r\niHUEARYKAB0WIQplaceholderplaceholderplaceholderplaceholder\r\n=AAAA\r\n-----END PGP SIGNATURE-----\r\n';

/** RFC 3156 multipart/encrypted: application/pgp-encrypted "Version: 1", then application/octet-stream. */
export function pgpMimeEncrypted(): Uint8Array {
  return concat([
    HEAD,
    'Subject: ...\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="enc"\r\n\r\n',
    'This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)\r\n',
    '--enc\r\nContent-Type: application/pgp-encrypted\r\nContent-Description: PGP/MIME version identification\r\n\r\nVersion: 1\r\n\r\n',
    '--enc\r\nContent-Type: application/octet-stream; name="encrypted.asc"\r\nContent-Description: OpenPGP encrypted message\r\nContent-Disposition: inline; filename="encrypted.asc"\r\n\r\n',
    ARMOR_MESSAGE,
    '\r\n--enc--\r\n',
  ]);
}

/**
 * Exchange's rewrite of a PGP/MIME encrypted message: multipart/mixed of an empty text/plain,
 * application/pgp-encrypted "Version: 1" and application/octet-stream (section 5, `exchange-shape`).
 */
export function exchangePgpMime(): Uint8Array {
  return concat([
    HEAD,
    'Subject: ...\r\nContent-Type: multipart/mixed; boundary="_003_exchange_"\r\n\r\n',
    '--_003_exchange_\r\nContent-Type: text/plain; charset="us-ascii"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n\r\n',
    '--_003_exchange_\r\nContent-Type: application/pgp-encrypted\r\nContent-Description: PGP/MIME version identification\r\nContent-Disposition: attachment; filename="PGPMIME Versions Identification"\r\nContent-Transfer-Encoding: base64\r\n\r\nVmVyc2lvbjogMQ0K\r\n\r\n',
    '--_003_exchange_\r\nContent-Type: application/octet-stream; name="encrypted.asc"\r\nContent-Description: OpenPGP encrypted message.asc\r\nContent-Disposition: attachment; filename="encrypted.asc"\r\nContent-Transfer-Encoding: base64\r\n\r\n',
    btoaLines(ARMOR_MESSAGE),
    '\r\n--_003_exchange_--\r\n',
  ]);
}

/**
 * RFC 3156 multipart/signed: a text/plain part, then application/pgp-signature. With `lineEnds: 'lf'` the
 * whole message has bare LF line ends (the signed `Ref` is then `canonical`, problem `canonicalized`).
 */
export function pgpMimeSigned(lineEnds: 'crlf' | 'lf' = 'crlf'): Uint8Array {
  const message = [
    HEAD,
    'Subject: signed\r\nContent-Type: multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="sig"\r\n\r\n',
    'This is an OpenPGP/MIME signed message (RFC 4880 and 3156)\r\n',
    '--sig\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nThe signed text.\r\n',
    '--sig\r\nContent-Type: application/pgp-signature; name="signature.asc"\r\nContent-Description: OpenPGP digital signature\r\nContent-Disposition: attachment; filename="signature.asc"\r\n\r\n',
    ARMOR_SIGNATURE,
    '\r\n--sig--\r\n',
  ].join('');
  return latin1(lineEnds === 'lf' ? message.replace(/\r\n/g, '\n') : message);
}

function btoaLines(s: string): string {
  const b = Buffer.from(s, 'latin1').toString('base64');
  return b.replace(/.{1,76}/g, (m) => m + '\r\n').replace(/\r\n$/, '');
}

// --- the inputs of other parsers' advisories, too large for files ---

/**
 * postal-mime's boundary near-miss DoS (fixed in 4.2.1, commit 3c3fd9e, test "lines that nearly match
 * every open boundary"): 250 nested multiparts, then 16,000 lines that start like every open boundary.
 */
export function postalMimeBoundaryNearMiss(depth = 250, lines = 16_000): Uint8Array {
  const prefix = 'B'.repeat(60);
  const chunks: string[] = [`Content-Type: multipart/mixed; boundary="${prefix}0"\r\n\r\n`];
  for (let i = 0; i < depth - 1; i++) chunks.push(`--${prefix}${i}\r\nContent-Type: multipart/mixed; boundary="${prefix}${i + 1}"\r\n\r\n`);
  chunks.push(`--${prefix}${depth - 1}\r\nContent-Type: text/plain\r\n\r\n`);
  const near = `--${prefix}_NOMATCH\r\n`;
  for (let i = 0; i < lines; i++) chunks.push(near);
  return concat(chunks);
}

/** postal-mime's address-count case (parse-cost-test.ts): `To: a@b,` 150,000 times. */
export function postalMimeManyAddresses(count = 150_000): Uint8Array {
  return concat([`To: ${'a@b,'.repeat(count)}\r\n\r\nx`]);
}

/**
 * Nodemailer's nested-group recursion (stack overflow fixed in b61b9c0): `g0: g1: … user@example.com;`
 * `depth` deep (default 3000, as its test).
 */
export function nodemailerDeepGroups(depth = 3000): Uint8Array {
  const groups: string[] = [];
  for (let i = 0; i < depth; i++) groups.push(`g${i}:`);
  return concat([HEAD.replace(/^To: .*\r\n/m, ''), `To: ${groups.join(' ')} user@example.com;\r\nSubject: deep groups\r\n\r\nx\r\n`]);
}

/**
 * Nodemailer's many-group-openers case: `g: ` 100,000 times, then `a@b.com, ` 60,000 times, in To (its test has
 * 80,000; 60,000 keeps the header block under the 1 MB root limit, so the address limit is what is met).
 */
export function nodemailerGroupOpeners(openers = 100_000, addresses = 60_000): Uint8Array {
  return concat([`To: ${'g: '.repeat(openers)}${'a@b.com, '.repeat(addresses)}\r\nSubject: openers\r\n\r\nx\r\n`]);
}

/** Every generator, by the name the manifest uses, with its default arguments. */
export const generators = {
  singlePart,
  manyParts,
  deepNesting,
  oversizedHeader,
  manyEncodedWords,
  manyInvalidEncodedWords,
  manyEncodedWordsUnderHeaderLimit: () => manyEncodedWords(50_000),
  boundaryPrefixOfParent,
  boundaryExtendsParent,
  missingCloseBoundary,
  transportPadding,
  lineEndMix,
  base64Junk,
  pgpMimeEncrypted,
  exchangePgpMime,
  pgpMimeSigned: () => pgpMimeSigned('crlf'),
  pgpMimeSignedLf: () => pgpMimeSigned('lf'),
  postalMimeBoundaryNearMiss,
  postalMimeManyAddresses,
  nodemailerDeepGroups,
  nodemailerGroupOpeners,
} satisfies Record<string, () => Uint8Array>;

export type GeneratorName = keyof typeof generators;
