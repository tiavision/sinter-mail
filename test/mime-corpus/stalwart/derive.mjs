// Derives structure.json from Stalwart mail-parser's expected parses.
//
//   node test/mime-corpus/stalwart/derive.mjs <mail-parser checkout>/resources/eml <commit> > test/mime-corpus/stalwart/structure.json
//
// Reads files only: each suite's NAME.eml and Stalwart's NAME.json (the parse of the message with every CR
// removed) or NAME.crlf.json (the parse with CRLF line ends), and prints JSON. It runs nothing from the
// checkout. Stalwart's JSON describes Stalwart's own data model; what is kept is what our reader must agree
// on whatever its model: the tree of content types, and per text part its charset and a short prefix of its
// decoded text. Every expectation is cross-checked against an independent reading of the bytes by the
// rules of docs/proposals/sinter-mail-mime.md section 3 (delimiter lines, header end, transfer decoding,
// WHATWG charsets); a message where the two disagree is skipped and listed with the reason, and a text
// prefix that cannot be confirmed is left out (the node's `textOmitted` says why).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SUITES = ['rfc', 'malformed', 'thirdparty', 'regressions']; // `legacy` is not redistributable (README)
const PREFIX = 40; // code points
const MAX_DEPTH = 32;
const MAX_PARTS = 1000;

const root = process.argv[2];
if (!root) throw new Error('usage: derive.mjs <mail-parser>/resources/eml');

class Skip extends Error {}
const skip = (reason) => {
  throw new Skip(reason);
};

// --- bytes, by the proposal's line rule: CRLF and bare LF end a line; a bare CR does not ---

function* lines(bytes, start, end) {
  let p = start;
  while (p < end) {
    let nl = bytes.indexOf(0x0a, p);
    if (nl === -1 || nl >= end) nl = -1;
    const lineEnd = nl === -1 ? end : nl; // exclusive, before LF
    const contentEnd = nl !== -1 && lineEnd > p && bytes[lineEnd - 1] === 0x0d ? lineEnd - 1 : lineEnd;
    const next = nl === -1 ? end : nl + 1;
    yield { start: p, contentEnd, next, breakStart: contentEnd, hasBreak: nl !== -1 };
    p = next;
  }
}

const ascii = (bytes, s, e) => {
  let out = '';
  for (let i = s; i < e; i++) out += String.fromCharCode(bytes[i]);
  return out;
};

// 'open' | 'close' | null, for a line against one boundary: `--` boundary, then `--` for the close, then
// optional SP / HTAB (transport padding), then the line end.
function delimiter(text, boundary) {
  if (!text.startsWith('--' + boundary)) return null;
  let rest = text.slice(2 + boundary.length);
  let kind = 'open';
  if (rest.startsWith('--')) {
    kind = 'close';
    rest = rest.slice(2);
  }
  return /^[ \t]*$/.test(rest) ? kind : null;
}

// The line break before a delimiter belongs to the delimiter.
function endBefore(bytes, lineStart, floor) {
  if (lineStart > floor && bytes[lineStart - 1] === 0x0a) {
    return lineStart - 1 > floor && bytes[lineStart - 2] === 0x0d ? lineStart - 2 : lineStart - 1;
  }
  return lineStart;
}

// Children of a multipart: header starts and ends, and whether the close delimiter was seen.
function scanMultipart(bytes, bodyStart, limit, boundary, ancestors) {
  const children = [];
  let open = null;
  let closed = false;
  let stop = limit;
  for (const line of lines(bytes, bodyStart, limit)) {
    const text = ascii(bytes, line.start, line.contentEnd);
    if (!text.startsWith('--')) continue;
    const own = delimiter(text, boundary);
    const ancestor = ancestors.some((b) => delimiter(text, b));
    if (!own && !ancestor) continue;
    if (open) open.end = endBefore(bytes, line.start, open.start);
    open = null;
    if (ancestor && !own) {
      stop = line.start;
      break;
    }
    if (own === 'close') {
      closed = true;
      stop = line.next;
      break;
    }
    open = { start: line.next, end: limit };
    children.push(open);
  }
  if (open) open.end = stop === limit ? limit : endBefore(bytes, stop, open.start);
  return { children, closed };
}

// Header block end: the first empty line. No empty line: the body is empty (`no-header-end`).
function headerEnd(bytes, start, end) {
  for (const line of lines(bytes, start, end)) {
    if (line.contentEnd === line.start && line.hasBreak) return { body: line.next, ok: true };
  }
  return { body: end, ok: false };
}

// --- transfer decoding, strict: only used where Stalwart reported no transfer problem ---

function base64(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out = [];
  let acc = 0;
  let n = 0;
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    if (c === "=") break;
    const v = alphabet.indexOf(c);
    if (v === -1) {
      if (b === 0x0d || b === 0x0a || b === 0x20 || b === 0x09) continue;
      return null;
    }
    acc = (acc << 6) | v;
    n += 6;
    if (n >= 8) {
      n -= 8;
      out.push((acc >> n) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function quotedPrintable(bytes) {
  const out = [];
  const hex = (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
  for (const line of lines(bytes, 0, bytes.length)) {
    let e = line.contentEnd;
    while (e > line.start && (bytes[e - 1] === 0x20 || bytes[e - 1] === 0x09)) e--;
    let soft = false;
    for (let i = line.start; i < e; i++) {
      const b = bytes[i];
      if (b !== 0x3d) {
        out.push(b);
        continue;
      }
      if (i === e - 1) {
        soft = true;
        break;
      }
      if (i + 2 < e && hex(bytes[i + 1]) && hex(bytes[i + 2])) {
        out.push(parseInt(String.fromCharCode(bytes[i + 1], bytes[i + 2]), 16));
        i += 2;
      } else return null; // qp-invalid: not confirmed here
    }
    if (!soft && line.hasBreak) {
      if (bytes[line.contentEnd] === 0x0d) out.push(0x0d);
      out.push(0x0a);
    }
  }
  return Uint8Array.from(out);
}

// --- Stalwart's model ---

const lower = (s) => s.toLowerCase();

function contentType(part) {
  const fields = (part.headers ?? []).filter((h) => lower(h.name) === 'content-type');
  if (fields.length > 1) skip(`part ${part.id}: ${fields.length} Content-Type fields`);
  if (fields.length === 0) return null;
  const ct = fields[0].value?.content_type;
  if (!ct || !ct.type) skip(`part ${part.id}: Content-Type not parsed by Stalwart`);
  const params = new Map();
  for (const [k, v] of ct.attributes ?? []) {
    const key = lower(k);
    if (params.has(key) && ['boundary', 'charset', 'protocol'].includes(key))
      skip(`part ${part.id}: repeated ${key} parameter`);
    if (!params.has(key)) params.set(key, v);
  }
  const type = lower(ct.type) + '/' + lower(ct.subtype ?? '');
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) skip(`part ${part.id}: content type "${type}"`);
  return { type, params };
}

function transferEncoding(part) {
  const fields = (part.headers ?? []).filter((h) => lower(h.name) === 'content-transfer-encoding');
  if (fields.length > 1) skip(`part ${part.id}: repeated Content-Transfer-Encoding`);
  return part.encoding; // 'none' | 'base64' | 'quoted-printable'
}

const REPLACEMENT = new Set(['csiso2022kr', 'hz-gb-2312', 'iso-2022-cn', 'iso-2022-cn-ext', 'iso-2022-kr', 'replacement']);
function whatwg(label) {
  if (REPLACEMENT.has(label)) return 'replacement'; // TextDecoder refuses these labels
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return null;
  }
}

function derive(bytes, parse) {
  const parts = parse.parts;
  const messages = parse.messages;
  const problems = [];
  let count = 0;

  function node(partId, region, parentType, ancestors, depth, messageDepth) {
    const part = parts[partId];
    if (++count > MAX_PARTS) skip('more than 1,000 parts');
    if (depth > MAX_DEPTH) skip('deeper than 32 levels');
    if ((part.flags ?? []).includes('fallback_delimiter')) skip(`part ${partId}: Stalwart used a mid-line delimiter`);
    if (part.offset_header !== region.start) skip(`part ${partId}: header offset ${part.offset_header}, expected ${region.start}`);
    const head = headerEnd(bytes, region.start, region.end);
    let note = null;
    const stalwartNoBlank = (part.flags ?? []).includes('no_blank_line');
    if (head.ok) {
      if (part.offset_body !== head.body) skip(`part ${partId}: body offset ${part.offset_body}, expected ${head.body}`);
      if (stalwartNoBlank) skip(`part ${partId}: header end disagrees with no_blank_line`);
    } else if (stalwartNoBlank) {
      problems.push('no-header-end');
    } else if (part.offset_end <= part.offset_body) {
      // `Headers\n\n--b`: the empty line is the delimiter's line break. Both readers give an empty body;
      // RFC 2046's grammar allows a body part without a body, the proposal's `no-header-end` reads it as
      // headers running to the end. Neither expectation is asserted.
      note = `headers end at the delimiter's line break (empty body; no-header-end per the proposal, legal per RFC 2046)`;
    } else skip(`part ${partId}: Stalwart found a header end at ${part.offset_body}, the scan none`);

    const ct = contentType(part);
    const type = ct ? ct.type : parentType === 'multipart/digest' ? 'message/rfc822' : 'text/plain';
    const out = { type };
    if (note) out.note = note;
    const encoding = transferEncoding(part);

    if (type.startsWith('multipart/')) {
      if (part.kind !== 'multipart') skip(`part ${partId}: ${type} read by Stalwart as ${part.kind}`);
      if (encoding !== 'none') skip(`part ${partId}: transfer encoding on a multipart`);
      const boundary = ct.params.get('boundary');
      if (!boundary) skip(`part ${partId}: multipart without boundary`);
      if (boundary.length > 70) skip(`part ${partId}: boundary longer than 70`);
      if (ancestors.some((a) => boundary.startsWith(a))) skip(`part ${partId}: boundary starts with an ancestor's`);
      const scan = scanMultipart(bytes, head.body, region.end, boundary, ancestors);
      const unterminated = (part.flags ?? []).includes('unterminated');
      if (scan.closed === unterminated) skip(`part ${partId}: close delimiter disagrees with unterminated flag`);
      if (!scan.closed) problems.push('boundary-missing-close');
      const kids = part.children ?? [];
      if (kids.length !== scan.children.length)
        skip(`part ${partId}: Stalwart has ${kids.length} children, delimiter scan ${scan.children.length}`);
      out.parts = kids.map((k, i) =>
        node(k, scan.children[i], type, [...ancestors, boundary], depth + 1, messageDepth),
      );
      return out;
    }
    if (part.kind === 'multipart') skip(`part ${partId}: Stalwart read ${type} as a multipart`);

    if (type === 'message/rfc822' || type === 'message/global') {
      if (part.kind !== 'message') skip(`part ${partId}: ${type} read by Stalwart as ${part.kind}`);
      if (encoding !== 'none') skip(`part ${partId}: transfer encoding on a message`);
      if (messageDepth >= 8) skip('more than 8 nested messages');
      const inner = messages[part.nested];
      out.message = node(inner.root, { start: head.body, end: region.end }, null, ancestors, depth + 1, messageDepth + 1);
      return out;
    }
    if (part.kind === 'message') skip(`part ${partId}: Stalwart read ${type} as a message`);

    if (type.startsWith('text/')) {
      const label = ct?.params.get('charset');
      out.charset = label === undefined ? null : lower(label.trim());
      const enc = out.charset === null ? 'utf-8' : whatwg(out.charset);
      out.encoding = enc;
      const reason = textReason(part, enc, encoding, head.body, region.end);
      if (typeof reason === 'string') out.textOmitted = reason;
      else out.text = reason.prefix;
    }
    return out;
  }

  function textReason(part, enc, encoding, start, end) {
    if (typeof part.text !== 'string') return 'Stalwart recorded no text';
    if ((part.decode_problems ?? []).length) return `Stalwart reported ${part.decode_problems.join(', ')}`;
    if (!enc) return 'not a WHATWG label';
    if (enc === 'replacement') return 'WHATWG replacement encoding';
    const prefix = Array.from(part.text).slice(0, PREFIX).join('');
    if (/[\u0080-\u009f�]/.test(prefix)) return 'C1 control or U+FFFD in the prefix';
    const raw = bytes.subarray(start, end);
    const decodedBytes =
      encoding === 'base64' ? base64(raw) : encoding === 'quoted-printable' ? quotedPrintable(raw) : raw;
    if (!decodedBytes) return 'transfer encoding not confirmed';
    let ours;
    try {
      ours = new TextDecoder(enc, { fatal: true }).decode(decodedBytes);
    } catch {
      return 'bytes invalid in the charset';
    }
    if (!ours.startsWith(prefix)) return 'independent decoding disagrees';
    return { prefix };
  }

  const tree = node(messages[0].root, { start: 0, end: bytes.length }, null, [], 1, 0);
  return { problems: [...new Set(problems)].sort(), tree };
}

function lineEnds(bytes) {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) bytes[i - 1] === 0x0d ? crlf++ : lf++;
    else if (bytes[i] === 0x0d && bytes[i + 1] !== 0x0a) cr++;
  }
  if (cr) return 'mixed';
  if (lf && crlf) return 'mixed';
  return crlf ? 'crlf' : 'lf';
}

const result = {
  source: { repository: 'https://github.com/stalwartlabs/mail-parser', commit: process.argv[3] ?? null, derivedBy: 'derive.mjs' },
  format: {
    tree: 'type: lowercased type/subtype as declared (text/plain, or message/rfc822 in a multipart/digest, when absent); parts: children of a multipart in order; message: the root entity of a message/rfc822 or message/global',
    charset: 'text/* only: the charset parameter, lowercased, or null when absent',
    encoding: 'text/* only: the WHATWG encoding name TextDecoder gives for the label (utf-8 when absent), or null when the label is not a WHATWG one',
    text: `text/* only: the first ${PREFIX} code points of the decoded text (line ends as in the file), present only when Stalwart and an independent decoding agree; textOmitted says why one is missing`,
    problems: 'problem codes the delimiter and header scan expects somewhere in the message (at least these)',
  },
  messages: {},
  skipped: {},
};
for (const suite of SUITES) {
  const dir = join(root, suite);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.eml')).sort()) {
    const key = `${suite}/${file}`;
    const bytes = new Uint8Array(readFileSync(join(dir, file)));
    const ends = lineEnds(bytes);
    const base = join(dir, file.slice(0, -4));
    if (ends === 'mixed') {
      result.skipped[key] = 'mixed line ends: Stalwart parsed only LF and CRLF normalizations of it';
      continue;
    }
    const jsonPath = ends === 'crlf' ? base + '.crlf.json' : base + '.json';
    if (!existsSync(jsonPath)) {
      result.skipped[key] = 'no expected parse';
      continue;
    }
    try {
      const d = derive(bytes, JSON.parse(readFileSync(jsonPath, 'utf8')));
      result.messages[key] = { lineEnds: ends, problems: d.problems, tree: d.tree };
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
      result.skipped[key] = e.message;
    }
  }
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
