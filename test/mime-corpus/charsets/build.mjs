// Builds the charset fixtures of this directory:
//
//   node test/mime-corpus/charsets/build.mjs [<jsmime checkout>]
//
// - own.eml and own.expected.json: one text/plain part per charset, written here. The bytes are made by
//   inverting Node's TextDecoder (no encoder for these charsets ships with Node), and the expected strings
//   are TextDecoder's output read by the rules of docs/proposals/sinter-mail-mime.md section 3 ("Charsets").
// - jsmime-*.expected.json: expectations for the messages copied from jsmime's test/data (MIT), when a
//   jsmime checkout is given: computed with TextDecoder, then checked against what jsmime's own tests
//   assert (pairs of parts that must decode equal; the Shift_JIS body string).
// - encoded-words.json: jsmime's decodeRFC2047Words cases (test/test_header.js) with jsmime's expected
//   string and the proposal's, computed by a small reference decoder below.
//
// Deterministic. Writes only into this directory; reads only files from the checkout, runs nothing there.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsmime = process.argv[2] ?? null;

const environment = {
  node: process.version,
  icu: process.versions.icu ?? null,
  fullIcu: process.config?.variables?.icu_small === false && typeof Intl === 'object',
};

// --- inverting TextDecoder ---

const reverseTables = new Map();
function reverse(label) {
  if (reverseTables.has(label)) return reverseTables.get(label);
  const table = new Map();
  const decoder = new TextDecoder(label, { fatal: true });
  const tryBytes = (bytes) => {
    let s;
    try {
      s = decoder.decode(Uint8Array.from(bytes));
    } catch {
      return;
    }
    if (Array.from(s).length === 1 && !table.has(s)) table.set(s, bytes);
  };
  for (let a = 0; a < 0x80; a++) tryBytes([a]);
  for (let a = 0x80; a < 0x100; a++) tryBytes([a]);
  if (['shift_jis', 'gbk', 'gb18030', 'big5', 'euc-kr', 'euc-jp'].includes(label)) {
    for (let a = 0x81; a < 0xff; a++) for (let b = 0x40; b < 0xff; b++) tryBytes([a, b]);
  }
  reverseTables.set(label, table);
  return table;
}

function encode(label, text) {
  if (label === 'utf-8') return [...new TextEncoder().encode(text)];
  if (label === 'iso-2022-jp') return encode2022jp(text);
  const table = reverse(label);
  const out = [];
  for (const ch of text) {
    if (label === 'gb18030' && ch === '\u{1f4a9}') {
      out.push(0x94, 0x39, 0xda, 0x33); // four-byte GB18030, from jsmime's test_header.js
      continue;
    }
    const bytes = table.get(ch);
    if (!bytes) throw new Error(`${label} cannot encode ${JSON.stringify(ch)}`);
    out.push(...bytes);
  }
  return out;
}

// ISO-2022-JP: ASCII, or JIS X 0208 between ESC $ B and ESC ( B. The JIS table is TextDecoder's own.
let jisTable = null;
function encode2022jp(text) {
  if (!jisTable) {
    jisTable = new Map();
    const d = new TextDecoder('iso-2022-jp', { fatal: true });
    for (let a = 0x21; a < 0x7f; a++)
      for (let b = 0x21; b < 0x7f; b++) {
        try {
          const s = d.decode(Uint8Array.from([0x1b, 0x24, 0x42, a, b, 0x1b, 0x28, 0x42]));
          if (Array.from(s).length === 1 && !jisTable.has(s)) jisTable.set(s, [a, b]);
        } catch {}
      }
  }
  const out = [];
  let jis = false;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) {
      if (jis) out.push(0x1b, 0x28, 0x42);
      jis = false;
      out.push(c);
    } else {
      const pair = jisTable.get(ch);
      if (!pair) throw new Error(`iso-2022-jp cannot encode ${ch}`);
      if (!jis) out.push(0x1b, 0x24, 0x42);
      jis = true;
      out.push(...pair);
    }
  }
  if (jis) out.push(0x1b, 0x28, 0x42);
  return out;
}

// --- transfer encodings (writing) ---

const b64 = (bytes) => {
  const s = Buffer.from(bytes).toString('base64');
  return s.replace(/.{1,76}/g, (m) => m + '\r\n').replace(/\r\n$/, '');
};
const qp = (bytes) => {
  let line = '';
  const lines = [];
  for (const b of bytes) {
    const t = (b >= 0x21 && b <= 0x7e && b !== 0x3d) || b === 0x20 ? String.fromCharCode(b) : '=' + b.toString(16).toUpperCase().padStart(2, '0');
    if (line.length + t.length > 75) {
      lines.push(line + '=');
      line = '';
    }
    line += t;
  }
  lines.push(line.endsWith(' ') ? line.slice(0, -1) + '=20' : line);
  return lines.join('\r\n');
};

// --- own.eml ---

// WHATWG's replacement labels: TextDecoder refuses to construct them; the Encoding Standard decodes them
// to one U+FFFD (for a non-empty input).
const REPLACEMENT = new Set(['csiso2022kr', 'hz-gb-2312', 'iso-2022-cn', 'iso-2022-cn-ext', 'iso-2022-kr', 'replacement']);
const whatwg = (label) => {
  if (REPLACEMENT.has(label.trim().toLowerCase())) return 'replacement';
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return null;
  }
};

const strictDecode = (label, bytes) => new TextDecoder(label, { fatal: true }).decode(Uint8Array.from(bytes));
const lenientDecode = (label, bytes) => new TextDecoder(label).decode(Uint8Array.from(bytes));

const own = [
  { label: 'ISO-8859-1', encoding: 'quoted-printable', text: 'Grüße aus Köln, ça va? Ñandú, Ærø.' },
  // WHATWG reads ISO-8859-1 as windows-1252: byte 0x80 is the euro sign, not U+0080
  { label: 'iso-8859-1', encoding: 'quoted-printable', bytes: [0x50, 0x72, 0x69, 0x63, 0x65, 0x3a, 0x20, 0x80, 0x35, 0x20, 0x96, 0x20, 0x93, 0x6f, 0x6b, 0x94], note: 'ISO-8859-1 is windows-1252 in WHATWG: 0x80 0x93 0x94 0x96 are € “ ” –' },
  { label: 'ISO-8859-2', encoding: 'quoted-printable', text: 'Zażółć gęślą jaźń. Příliš žluťoučký kůň úpěl ďábelské ódy.' },
  { label: 'ISO-8859-15', encoding: 'quoted-printable', text: 'Le cœur déçu mais l’âme plutôt naïve, Louÿs rêva; Œuvre, Ÿ, € 5, Šž.'.replace('’', "'") },
  { label: 'windows-1252', encoding: '8bit', text: '“Smart quotes” – en dash … ‰ Œ ž • ™' },
  { label: 'KOI8-R', encoding: 'base64', text: 'Съешь же ещё этих мягких французских булок, да выпей чаю.' },
  { label: 'Shift_JIS', encoding: 'base64', text: 'いろはにほへと ちりぬるを 日本語のテキスト、カタカナ。' },
  { label: 'ISO-2022-JP', encoding: '7bit', text: 'こんにちは、世界。Mixed ASCII and 日本語.' },
  { label: 'GB18030', encoding: 'base64', text: '你好，世界！简体中文测试 \u{1f4a9}' },
  { label: 'Big5', encoding: 'base64', text: '繁體中文測試，你好世界。' },
  { label: 'utf-8', encoding: '8bit', text: 'UTF-8: Ünïcödé ✓ 日本 \u{1f600}' },
  {
    label: 'utf-8',
    encoding: 'base64',
    bytes: [...new TextEncoder().encode('caf'), 0xc3, 0xa9, 0x20, 0xff, 0xfe, 0x20, ...new TextEncoder().encode('na'), 0xef, ...new TextEncoder().encode('ve')],
    note: 'invalid UTF-8: the whole part falls back to windows-1252 (section 3), charset-fallback',
  },
  {
    label: null,
    encoding: '8bit',
    bytes: [...new TextEncoder().encode('no charset, Latin-1 bytes: '), 0x47, 0x72, 0xfc, 0xdf, 0x65],
    note: 'no charset: UTF-8, invalid, so windows-1252 (charset-fallback)',
  },
  { label: 'UTF-7', encoding: '7bit', bytes: [...new TextEncoder().encode('Hi Mom -+Jjo--! A+ImIDkQ.')], note: 'UTF-7 is never decoded: read as UTF-8 with charset-unknown (section 3); RFC 2152 examples' },
  { label: 'x-no-such-charset', encoding: '7bit', bytes: [...new TextEncoder().encode('plain ASCII under an unknown label')], note: 'unknown label: UTF-8 and charset-unknown' },
  { label: 'ISO-2022-KR', encoding: '7bit', bytes: [0x1b, 0x24, 0x29, 0x43, 0x0e, 0x3e, 0x48, 0x0f], note: 'a WHATWG replacement label: one U+FFFD (section 3)' },
];

function expectFor(part, bytes) {
  const label = part.label;
  if (label === null) {
    try {
      return { text: strictDecode('utf-8', bytes), problems: [] };
    } catch {
      return { text: lenientDecode('windows-1252', bytes), problems: ['charset-fallback'] };
    }
  }
  const enc = whatwg(label);
  if (enc === 'replacement') return { text: bytes.length ? '\ufffd' : '', problems: [] };
  if (enc === null) {
    try {
      return { text: strictDecode('utf-8', bytes), problems: ['charset-unknown'] };
    } catch {
      return { text: lenientDecode('windows-1252', bytes), problems: ['charset-unknown', 'charset-fallback'] };
    }
  }
  if (enc === 'utf-8') {
    try {
      return { text: strictDecode('utf-8', bytes), problems: [] };
    } catch {
      return { text: lenientDecode('windows-1252', bytes), problems: ['charset-fallback'] };
    }
  }
  return { text: lenientDecode(enc, bytes), problems: [] };
}

{
  const boundary = 'charsets-boundary-7f3a';
  const words = [
    ['ISO-8859-1', 'Q', encode('windows-1252', 'Grüße')],
    ['KOI8-R', 'B', encode('koi8-r', 'привет')],
    ['Shift_JIS', 'B', encode('shift_jis', '日本')],
    ['UTF-8', 'Q', encode('utf-8', '✓')],
  ];
  const ew = (cs, e, bytes) =>
    `=?${cs}?${e}?${e === 'B' ? Buffer.from(bytes).toString('base64') : bytes.map((b) => (b < 0x80 && b > 0x20 && b !== 0x3d && b !== 0x3f && b !== 0x5f ? String.fromCharCode(b) : '=' + b.toString(16).toUpperCase().padStart(2, '0'))).join('')}?=`;
  const subject = words.map((w) => ew(...w)).join('\r\n ');
  const head = [
    'From: Charset Test <charsets@example.test>',
    'To: reader@example.test',
    `Subject: ${subject}`,
    'Date: Tue, 24 Nov 2026 09:30:00 +0100',
    'Message-ID: <charsets.own@example.test>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join('\r\n');
  let body = '';
  const expected = [];
  own.forEach((part, i) => {
    const bytes = part.bytes ?? encode(new TextDecoder(part.label).encoding, part.text);
    if (part.text !== undefined && strictDecode(new TextDecoder(part.label).encoding, bytes) !== part.text)
      throw new Error(`round trip failed for ${part.label}`);
    const ct = part.label === null ? 'text/plain' : `text/plain; charset=${part.label}`;
    const encoded =
      part.encoding === 'base64' ? b64(bytes) : part.encoding === 'quoted-printable' ? qp(bytes) : Buffer.from(bytes).toString('latin1');
    body += `--${boundary}\r\nContent-Type: ${ct}\r\nContent-Transfer-Encoding: ${part.encoding}\r\n\r\n${encoded}\r\n`;
    const e = expectFor(part, bytes);
    expected.push({
      part: `1.${i + 1}`,
      charset: part.label,
      transferEncoding: part.encoding,
      text: e.text,
      problems: e.problems,
      ...(part.note ? { note: part.note } : {}),
    });
  });
  body += `--${boundary}--\r\n`;
  const message = Buffer.from(`${head}\r\n\r\nParts in many charsets, one per part.\r\n${body}`, 'latin1');
  writeFileSync(join(here, 'own.eml'), message);
  writeFileSync(
    join(here, 'own.expected.json'),
    JSON.stringify(
      {
        file: 'own.eml',
        generatedBy: 'build.mjs',
        environment,
        basis: 'docs/proposals/sinter-mail-mime.md section 3, Charsets: WHATWG labels through TextDecoder; no charset is UTF-8; invalid UTF-8 falls back to windows-1252; other labels (UTF-7 included) decode as UTF-8 with a problem; replacement labels give U+FFFD',
        subject: words.map(([, , b], i) => lenientDecode(['windows-1252', 'koi8-r', 'shift_jis', 'utf-8'][i], b)).join(''),
        subjectNote: 'four encoded words in four charsets, folded; adjacent words join without the whitespace between them',
        parts: expected,
      },
      null,
      2,
    ) + '\n',
  );
}

// --- jsmime messages ---

function decodeTransfer(encoding, text) {
  if (encoding === 'base64') return [...Buffer.from(text.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')];
  if (encoding === 'quoted-printable') {
    const out = [];
    const s = text.replace(/[ \t]+(\r?\n)/g, '$1').replace(/=\r?\n/g, '');
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
        out.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else out.push(s.charCodeAt(i));
    }
    return out;
  }
  return [...Buffer.from(text, 'latin1')];
}

// A minimal split for these two well-formed messages only: CRLF or LF, one boundary, no nesting.
function splitSimple(raw, boundary) {
  const text = raw.toString('latin1');
  const delim = new RegExp(`(?:^|\\r?\\n)--${boundary}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g');
  const marks = [...text.matchAll(delim)];
  const parts = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const start = marks[i].index + marks[i][0].length;
    const chunk = text.slice(start, marks[i + 1].index).replace(/^\r?\n/, '');
    const m = /\r?\n\r?\n/.exec(chunk);
    const headers = chunk.slice(0, m.index);
    const body = chunk.slice(m.index + m[0].length);
    const ct = /^content-type:\s*([^\r\n]*)/im.exec(headers)?.[1] ?? 'text/plain';
    const charset = /charset="?([^";\s]+)"?/i.exec(ct)?.[1] ?? null;
    const cte = (/^content-transfer-encoding:\s*(\S+)/im.exec(headers)?.[1] ?? '7bit').toLowerCase();
    parts.push({ type: ct.split(';')[0].trim().toLowerCase(), charset, cte, body });
  }
  return parts;
}

if (jsmime) {
  const data = join(jsmime, 'test', 'data');
  {
    const raw = readFileSync(join(data, 'charsets'));
    writeFileSync(join(here, 'jsmime-charsets.eml'), raw);
    const parts = splitSimple(raw, 'boundary').map((p, i) => {
      const bytes = decodeTransfer(p.cte, p.body);
      const e = expectFor({ label: p.charset }, bytes);
      return { part: `1.${i + 1}`, charset: p.charset, transferEncoding: p.cte, text: e.text, problems: e.problems };
    });
    if (parts.length !== 12) throw new Error('jsmime charsets: expected 12 parts');
    for (let i = 0; i < 12; i += 2)
      if (parts[i].text !== parts[i + 1].text) throw new Error(`jsmime charsets: parts ${i + 1} and ${i + 2} differ`);
    writeFileSync(
      join(here, 'jsmime-charsets.expected.json'),
      JSON.stringify(
        {
          file: 'jsmime-charsets.eml',
          source: 'jsmime test/data/charsets; jsmime test_mime_tree.js "Charset conversion" asserts parts 1+2, 3+4, … 11+12 decode equal',
          environment,
          parts,
        },
        null,
        2,
      ) + '\n',
    );
  }
  {
    const raw = readFileSync(join(data, 'shift-jis-image'));
    writeFileSync(join(here, 'jsmime-shift-jis-image.eml'), raw);
    const [text, image] = splitSimple(raw, 'vungrzvzr');
    const decoded = expectFor({ label: text.charset }, decodeTransfer(text.cte, text.body)).text;
    // jsmime's assertion (test_mime_tree.js), whose line end is CRLF; the file's is LF
    const asserted =
      'Portable Network Graphics（ポータブル・ネットワー' +
      'ク・グラフィックス、PNG）はコンピュータでビッ' +
      'トマップ画像を扱うファイルフォーマットである' +
      '。圧縮アルゴリズムとしてDeflateを採用している、' +
      '圧縮による画質の劣化のない可逆圧縮の画像ファ' +
      'イルフォーマットである。\n';
    if (decoded !== asserted) throw new Error('jsmime shift-jis-image: TextDecoder disagrees with jsmime');
    writeFileSync(
      join(here, 'jsmime-shift-jis-image.expected.json'),
      JSON.stringify(
        {
          file: 'jsmime-shift-jis-image.eml',
          source: 'jsmime test/data/shift-jis-image; body string from jsmime test_mime_tree.js, with its CRLF read as the file\'s LF',
          environment,
          parts: [
            { part: '1.1', charset: text.charset, transferEncoding: text.cte, text: decoded, problems: [] },
            { part: '1.2', type: image.type, charset: null, note: 'image/png: no charset applies' },
          ],
          note: 'Content-Description holds raw Shift_JIS bytes; jsmime decodes them with the part charset (ケツァルコアトル). The proposal reads 8-bit headers as UTF-8 (RFC 6532) and does not say more, so no expectation is set for it.',
        },
        null,
        2,
      ) + '\n',
    );
  }
}

// --- encoded words ---

// jsmime test/test_header.js, suite decodeRFC2047Words: [input, jsmime's expected].
const jsmimeWords = [
  ['Test', 'Test'],
  ['Test 2', 'Test 2'],
  ['Basic  words', 'Basic  words'],
  ['Not a =? word', 'Not a =? word'],
  ['=?UTF-8?Q?Encoded?=', 'Encoded'],
  ['=?UTF-8?q?Encoded?=', 'Encoded'],
  ['=?ISO-8859-1?Q?oxyg=e8ne?=', 'oxygène'],
  ['=?UTF-8?B?QmFzZTY0?=', 'Base64'],
  ['=?UTF-8?b?QmFzZTY0?=', 'Base64'],
  ['=?UTF-8?Q?A_space?=', 'A space'],
  ['=?UTF-8?Q?A space?=', 'A space'],
  ['A =?UTF-8?Q?B?= C', 'A B C'],
  ['=?UTF-8?Q?A?= =?UTF-8?Q?B?=', 'AB'],
  ['=?UTF-8?Q?oxyg=c3=a8ne?=', 'oxygène'],
  ['=?utf-8?Q?oxyg=C3=A8ne?=', 'oxygène'],
  ['=?UTF-8?B?b3h5Z8OobmU=?=', 'oxygène'],
  ['=?UTF-8*fr?B?b3h5Z8OobmU=?=', 'oxygène'],
  [
    '=?BIG5?Q?=B9=CF=AE=D1=C0]SSCI=A4=CEJCR=B8=EA=AE=C6=AEw=C1=BF=B2=DF=A1A=A8' +
      '=F3=A7U=B1z=A1u=B4=A3=A4=C9=AC=E3=A8s=AF=C0=BD=E8=BBP=AE=C4=B2v=A5H=A4=CE' +
      '=A7=EB=BDZ=B5=A6=B2=A4=AA=BA=B9B=A5=CE=A1v=A1A=C5w=AA=EF=B3=F8=A6W=B0=D1' +
      '=A5[=A1C?=',
    '圖書館SSCI及JCR資料庫講' +
      '習，協助您「提升研究素質' +
      '與效率以及投稿策略的運用' +
      '」，歡迎報名參加。',
  ],
  ['=?UTF-8?Q?=f0ab?=', '�ab'],
  ['=?UTF-8?Q?=f0?= ab', '� ab'],
  ['=?UTF-8?Q?=ed=a0=bd=ed=b2=a9?=', '������'],
  ['=?NoSuchCharset?Q?ab?=', '=?NoSuchCharset?Q?ab?='],
  ['=?UTF-8?U?Encoded?=', '=?UTF-8?U?Encoded?='],
  ['=?UTF-8?Q?Almost', '=?UTF-8?Q?Almost'],
  ['=?UTF-8?B?8J+SqQ==?=', '💩'],
  ['=?GB18030?B?lDnaMw==?=', '💩'],
  ['=?UTF-8?Q?=f0=9f?= =?UTF-8?Q?=92=a9?=', '💩'],
  ['=?UTF-8?B?8J+S?= =?UTF-8?B?qQ==?=', '💩'],
  ['=?UTF-8?B?8J+S?= =?UTF-8?Q?=a9?=', '💩'],
  ['=?UTF-8?B?8J+S?= =?ISO-8859-1?B?qQ==?=', '�©'],
  ['=?UTF-8?Q?=f0?= =?UTF-8?Q?ab?=', '�ab'],
  [
    '=?UTF-8?B?YfCfkqnwn5Kp8J+SqfCfkqnwn5Kp8J+SqfCfkqnvv70=?= =?UTF-8?B?77+9?=',
    'a💩💩💩💩💩💩💩��',
  ],
  ['=?UTF-8?Q?Invalid token?=', 'Invalid token'],
  ['AAA =?UTF-8?Q?bbb?= CCC =?UTF-8?Q?ddd?= EEE =?UTF-8?Q?fff?= GGG', 'AAA bbb CCC ddd EEE fff GGG'],
  [
    '=?UTF-8?B?4oiAICDiiIEgIOKIgiAg4oiDICDiiIQgIOKIhSAg4oiGICDiiIcgIOKIiCAg?=\n =?UTF-8?B?4oiJICDiiIogIOKIiyAg4oiMICDiiI0gIOKIjiAg4oiP?=',
    '∀  ∁  ∂  ∃  ∄  ∅  ∆  ∇  ∈  ∉  ∊  ∋  ∌  ∍  ∎  ∏',
  ],
  [
    '=?utf-8?Q?=E2=88=80__=E2=88=81__=E2=88=82__=E2=88=83__=E2=88=84__=E2?=\n =?utf-8?Q?=88=85__=E2=88=86__=E2=88=87__=E2=88=88__=E2=88=89__=E2=88?=\n =?utf-8?Q?=8A__=E2=88=8B__=E2=88=8C__=E2=88=8D__=E2=88=8E__=E2=88=8F?=',
    '∀  ∁  ∂  ∃  ∄  ∅  ∆  ∇  ∈  ∉  ∊  ∋  ∌  ∍  ∎  ∏',
  ],
  [
    '=?UTF-8?B?4oiAICDiiIEgIOKIgiAg4oiDICDiiIQgIOKIhSAg4oiGICDiiIcgIOKIiA==?=\n =?UTF-8?B?ICDiiIkgIOKIiiAg4oiLICDiiIwgIOKIjSAg4oiOICDiiI8=?=',
    '∀  ∁  ∂  ∃  ∄  ∅  ∆  ∇  ∈  ∉  ∊  ∋  ∌  ∍  ∎  ∏',
  ],
  [
    '=?UTF-8?b?4oiAICDiiIEgIOKIgiAg4oiDICDiiIQgIOKIhSAg4oiGICDiiIcgIOKIiA==?=\n =?UTF-8?b?ICDiiIkgIOKIiiAg4oiLICDiiIwgIOKIjSAg4oiOICDiiI8=?=',
    '∀  ∁  ∂  ∃  ∄  ∅  ∆  ∇  ∈  ∉  ∊  ∋  ∌  ∍  ∎  ∏',
  ],
  [
    '=?utf-8?Q?=E2=88=80__=E2=88=81__=E2=88=82__=E2=88=83__=E2=88=84__?=\n =?utf-8?Q?=E2=88=85__=E2=88=86__=E2=88=87__=E2=88=88__=E2=88=89__?=\n =?utf-8?Q?=E2=88=8A__=E2=88=8B__=E2=88=8C__=E2=88=8D__=E2=88=8E__?=\n =?utf-8?Q?=E2=88=8F?=',
    '∀  ∁  ∂  ∃  ∄  ∅  ∆  ∇  ∈  ∉  ∊  ∋  ∌  ∍  ∎  ∏',
  ],
  [
    '=?utf-8?q?=E2=88=80__=E2=88=81__=E2=88=82__=E2=88=83__=E2=88=84__?=\n =?utf-8?q?=E2=88=85__=E2=88=86__=E2=88=87__=E2=88=88__=E2=88=89__?=\n =?utf-8?q?=E2=88=8A__=E2=88=8B__=E2=88=8C__=E2=88=8D__=E2=88=8E__?=\n =?utf-8?q?=E2=88=8F?=',
    '∀  ∁  ∂  ∃  ∄  ∅  ∆  ∇  ∈  ∉  ∊  ∋  ∌  ∍  ∎  ∏',
  ],
  [
    '=?UTF-8?B?4oiAICDiiIEgIOKIgiAg4oiDICDiiIQgIOKIhSAg4oiGICDiiIcgIOKIiA===?=\n =?UTF-8?B?ICDiiIkgIOKIiiAg4oiLICDiiIwgIOKIjSAg4oiOICDiiI8=?=',
    '∀  ∁  ∂  ∃  ∄  ∅  ∆  ∇  ∈  ∉  ∊  ∋  ∌  ∍  ∎  ∏',
  ],
  [
    'Re: [Kitchen Nightmares] Meow! Gordon Ramsay Is =?ISO-8859-1?B?UEgR lqZ VuIEhlYWQgVH rbGeOIFNob BJc RP2JzZXNzZW?= With My =?ISO-8859-1?B?SHVzYmFuZ JzX0JhbGxzL JfU2F5c19BbXiScw==?= Baking Company Owner',
    'Re: [Kitchen Nightmares] Meow! Gordon Ramsay Is =?ISO-8859-1?B?UEgR lqZ VuIEhlYWQgVH rbGeOIFNob BJc RP2JzZXNzZW?= With My =?ISO-8859-1?B?SHVzYmFuZ JzX0JhbGxzL JfU2F5c19BbXiScw==?= Baking Company Owner',
  ],
  ['=?us-ascii?Q?=09Edward_Rosten?=', '\tEdward Rosten'],
  ['=?us-ascii?Q?=3D=3FUTF-8=3FQ=3Ff=3DC3=3DBCr=3F=3D?=', '=?UTF-8?Q?f=C3=BCr?='],
  ['=??B?Sy4gSC4gdm9uIFLDvGRlbg==?=', '=??B?Sy4gSC4gdm9uIFLDvGRlbg==?='],
];

// Where the proposal does not settle the reading, no expectation is given.
const unsettled = new Map([
  ['=?UTF-8?Q?A space?=', 'a space inside an encoded word (not a token by RFC 2047); jsmime decodes it'],
  ['=?UTF-8?Q?Invalid token?=', 'a space inside an encoded word; jsmime decodes it'],
  ['=?UTF-8*fr?B?b3h5Z8OobmU=?=', 'RFC 2231 section 5 language suffix; the proposal does not mention it'],
]);

// Reference reading of an unstructured field by section 3: unfold; split on whitespace; a token that is a
// whole encoded word decodes; whitespace between two encoded words is dropped; consecutive words of one
// charset are joined into one buffer and decoded once; charsets as for bodies; controls removed.
const EW = /^=\?([^?*\s]+)(\*[^?\s]*)?\?([BbQq])\?([^?\s]*)\?=$/;
function proposalDecode(value) {
  const unfolded = value.replace(/\r?\n(?=[ \t])/g, '');
  const tokens = unfolded.split(/([ \t]+)/);
  const problems = new Set();
  const runs = []; // {kind:'text', s} | {kind:'ew', enc, bytes}
  let lastWasEw = false;
  let pendingSpace = '';
  for (const tok of tokens) {
    if (tok === '') continue;
    if (/^[ \t]+$/.test(tok)) {
      pendingSpace += tok;
      continue;
    }
    const m = EW.exec(tok);
    if (m) {
      const [, label, , e, payload] = m;
      let bytes;
      if (e.toUpperCase() === 'B') {
        if (!/^[A-Za-z0-9+/]*=*$/.test(payload)) bytes = null;
        else bytes = [...Buffer.from(payload, 'base64')];
      } else {
        bytes = [];
        for (let i = 0; i < payload.length; i++) {
          const c = payload[i];
          if (c === '_') bytes.push(0x20);
          else if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(payload.slice(i + 1, i + 3))) {
            bytes.push(parseInt(payload.slice(i + 1, i + 3), 16));
            i += 2;
          } else bytes.push(c.charCodeAt(0));
        }
      }
      if (bytes) {
        const enc = whatwg(label);
        if (enc === null) problems.add('charset-unknown');
        if (!lastWasEw && pendingSpace) runs.push({ kind: 'text', s: pendingSpace });
        pendingSpace = '';
        const prev = runs[runs.length - 1];
        const key = enc ?? 'utf-8';
        if (lastWasEw && prev.kind === 'ew' && prev.enc === key) prev.bytes.push(...bytes);
        else runs.push({ kind: 'ew', enc: key, bytes: [...bytes] });
        lastWasEw = true;
        continue;
      }
    }
    if (pendingSpace) runs.push({ kind: 'text', s: pendingSpace });
    pendingSpace = '';
    runs.push({ kind: 'text', s: tok });
    lastWasEw = false;
  }
  if (pendingSpace) runs.push({ kind: 'text', s: pendingSpace });
  let out = '';
  for (const r of runs) {
    if (r.kind === 'text') out += r.s;
    else if (r.enc === 'replacement') out += r.bytes.length ? '\ufffd' : '';
    else if (r.enc === 'utf-8') {
      try {
        out += strictDecode('utf-8', r.bytes);
      } catch {
        out += lenientDecode('windows-1252', r.bytes);
        problems.add('charset-fallback');
      }
    } else out += lenientDecode(r.enc, r.bytes);
  }
  out = out.replace(/[\u0000-\u001f\u007f‎‏؜‪-‮⁦-⁩]/g, '');
  return { text: out, problems: [...problems].sort() };
}

{
  const cases = jsmimeWords.map(([input, expected]) => {
    if (unsettled.has(input)) return { input, jsmime: expected, proposal: null, note: unsettled.get(input) };
    const p = proposalDecode(input);
    const entry = { input, jsmime: expected, proposal: p.text, problems: p.problems };
    if (p.text !== expected) entry.differs = true;
    return entry;
  });
  writeFileSync(
    join(here, 'encoded-words.json'),
    JSON.stringify(
      {
        source: 'jsmime test/test_header.js, suite decodeRFC2047Words (MIT, Copyright (c) 2013 Joshua Cranmer)',
        generatedBy: 'build.mjs',
        environment,
        format: {
          input: 'an unstructured field value (Subject), folded with LF as in jsmime',
          jsmime: "jsmime's expected decoded string",
          proposal: "the decoded string by docs/proposals/sinter-mail-mime.md section 3 (encoded words joined per charset run, the body charset table with its windows-1252 fallback, controls removed); null where the proposal does not settle it",
          problems: 'problem codes the proposal adds for this value',
          differs: 'true where the proposal deliberately reads it differently from jsmime',
        },
        cases,
      },
      null,
      2,
    ) + '\n',
  );
}
