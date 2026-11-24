// The MIME reader's lexical layer (sinter/mime: decode, charset, headers, address, date, filename, sha256, magic):
// every rule of docs/proposals/sinter-mail-mime.md sections 3 and 4 that these modules own, the attacks of its
// Pitfalls table that reach them, hostile inputs under a time bound, and purity (sinter's fold check).
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { addressKey, addresses, punycode, sameAddress } from '../sinter/mime/address.js';
import { decodeText, supported } from '../sinter/mime/charset.js';
import { parseDate } from '../sinter/mime/date.js';
import { base64, base64Result, canonicalize, hasBareLF, quotedPrintable, transferDecode, type Sink } from '../sinter/mime/decode.js';
import { filename, safeName } from '../sinter/mime/filename.js';
import {
  clean, contentType, decodeWords, hasControl, messageIds, parameterField, readHeaders, transferEncoding, unstructured,
} from '../sinter/mime/headers.js';
import { imageType } from '../sinter/mime/magic.js';
import { hex, sha256, stepDigest, verifyDigest } from '../sinter/mime/sha256.js';
import type { ProblemCode } from '../sinter/mime/types.js';

const enc = (s: string) => new TextEncoder().encode(s);
const latin = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const str = (b: Uint8Array) => new TextDecoder().decode(b);

/** a sink that records, and the records */
function problems(): [Sink, ProblemCode[]] {
  const list: ProblemCode[] = [];
  return [(c) => list.push(c), list];
}

/** run `f` and its result with the problems it reported */
function withProblems<T>(f: (sink: Sink) => T): [T, ProblemCode[]] {
  const [sink, list] = problems();
  return [f(sink), list];
}

const timed = <T>(f: () => T): [T, number] => { const t = performance.now(); const r = f(); return [r, performance.now() - t]; };

describe('base64', () => {
  const b64 = (s: string) => withProblems((sink) => str(base64(latin(s), 0, s.length, sink)));

  test('decodes, skipping whitespace and line ends silently', () => {
    expect(b64('aGVs\r\nbG8g\n d29y bGQ=')).toEqual(['hello world', []]);
    expect(b64('')).toEqual(['', []]);
  });

  test('characters outside the alphabet are skipped and reported once', () => {
    expect(b64('aGV*sb!G8=')).toEqual(['hello', ['base64-junk']]);
    expect(b64('a-G_V-s#bG8=')).toEqual(['hello', ['base64-junk']]);
  });

  test('padding mid-stream ends its quantum and decoding continues', () => {
    // two chunks concatenated: "hi" + "there"
    expect(b64('aGk=dGhlcmU=')).toEqual(['hithere', ['base64-junk']]);
    expect(b64('aA==aQ==')).toEqual(['hi', ['base64-junk']]);
    // padding at the very end, whitespace after it: no problem
    expect(b64('aGk=\r\n  \r\n')).toEqual(['hi', []]);
  });

  test('a final partial quantum is dropped', () => {
    expect(b64('aGVsbG8')).toEqual(['hel', ['base64-junk']]);
    expect(b64('aGVsbA')).toEqual(['hel', ['base64-junk']]);
    expect(b64('aGVsb')).toEqual(['hel', ['base64-junk']]);
  });

  test('wrong padding is reported', () => {
    expect(b64('aGk==')).toEqual(['hi', ['base64-junk']]);
    expect(b64('aA=')).toEqual(['h', ['base64-junk']]);
    expect(b64('====')).toEqual(['', ['base64-junk']]);
    expect(b64('a===')).toEqual(['', ['base64-junk']]);
  });

  test('decodes a byte range only; output never larger than input', () => {
    const src = latin('xxxaGVsbG8=yyy');
    expect(str(base64(src, 3, 11))).toBe('hello');
    const all = new Uint8Array(256).map((_, i) => i);
    const encoded = latin(Buffer.from(all).toString('base64'));
    expect([...base64(encoded, 0, encoded.length)]).toEqual([...all]);
  });
});

describe('quoted-printable', () => {
  const qp = (s: string) => withProblems((sink) => str(quotedPrintable(enc(s), 0, enc(s).length, sink)));

  test('hex escapes, either case', () => {
    expect(qp('caf=C3=A9 caf=c3=a9')).toEqual(['café café', []]);
  });

  test('whitespace before a soft break is content; after it, removed', () => {
    expect(qp('hello =\r\nworld')).toEqual(['hello world', []]);
    expect(qp('hello = \t\r\nworld')).toEqual(['hello world', []]);
    expect(qp('hello=\nworld')).toEqual(['helloworld', []]);
  });

  test('trailing whitespace on a hard line is removed, the line end kept as sent', () => {
    expect(qp('a  \r\nb\t\nc ')).toEqual(['a\r\nb\nc', []]);
  });

  test('= not followed by two hex digits is kept, qp-invalid', () => {
    expect(qp('a=ZZb')).toEqual(['a=ZZb', ['qp-invalid']]);
    expect(qp('a=4')).toEqual(['a=4', ['qp-invalid']]);
    expect(qp('1+1=2 =G0 =')).toEqual(['1+1=2 =G0 ', ['qp-invalid']]);
  });

  test('a bare CR is a character, not a line end', () => {
    expect(qp('a=\rb')).toEqual(['a=\rb', ['qp-invalid']]);
    expect(qp('a \rb')).toEqual(['a \rb', []]);
  });

  test('transferDecode dispatches; identity copies', () => {
    const src = enc('aGk=');
    expect(str(transferDecode(src, 0, 4, 'base64'))).toBe('hi');
    expect(str(transferDecode(enc('=41'), 0, 3, 'quoted-printable'))).toBe('A');
    const id = transferDecode(src, 1, 3, 'identity');
    expect(str(id)).toBe('Gk');
    id[0] = 0;
    expect(src[1]).toBe(0x47);
  });
});

describe('canonical line ends', () => {
  test('bare LF becomes CRLF, nothing else changes', () => {
    expect(str(canonicalize(enc('a\nb\r\nc\rd\n\n')))).toBe('a\r\nb\r\nc\rd\r\n\r\n');
    expect(str(canonicalize(enc('\n')))).toBe('\r\n');
    expect(hasBareLF(enc('a\r\nb'))).toBe(false);
    expect(hasBareLF(enc('a\r\nb\n'))).toBe(true);
    expect(hasBareLF(enc('\n'))).toBe(true);
  });
});

describe('charsets', () => {
  test('missing label is UTF-8; invalid UTF-8 is windows-1252', () => {
    expect(withProblems((s) => decodeText(enc('café'), null, s))).toEqual(['café', []]);
    expect(withProblems((s) => decodeText(latin('caf\xe9 \x80'), undefined, s))).toEqual(['café €', ['charset-fallback']]);
    expect(withProblems((s) => decodeText(latin('caf\xe9'), 'UTF-8', s))).toEqual(['café', ['charset-fallback']]);
  });

  test('WHATWG labels, as TextDecoder reads them', () => {
    expect(decodeText(latin('\xe9'), ' ISO-8859-1 ', () => {})).toBe('é');
    expect(decodeText(latin('\x80\x9f'), 'us-ascii', () => {})).toBe('€Ÿ');
    expect(decodeText(latin('\xe9'), 'iso-8859-15', () => {})).toBe('é');
    expect(decodeText(latin('\xa4'), 'iso-8859-15', () => {})).toBe('€');
    expect(decodeText(new Uint8Array([0x3d, 0x04]), 'utf-16le', () => {})).toBe('н');
    expect(decodeText(new Uint8Array([0x41, 0x80]), 'x-user-defined', () => {})).toBe('A\uf780');
  });

  test('unknown labels and UTF-7 decode as UTF-8, charset-unknown', () => {
    expect(withProblems((s) => decodeText(enc('+AGEAYgBj-'), 'utf-7', s))).toEqual(['+AGEAYgBj-', ['charset-unknown']]);
    expect(withProblems((s) => decodeText(enc('ü'), 'x-bogus', s))).toEqual(['ü', ['charset-unknown']]);
    expect(withProblems((s) => decodeText(latin('\xfc'), 'x-bogus', s))).toEqual(['ü', ['charset-unknown', 'charset-fallback']]);
    expect(supported('utf-7')).toBe(false);
    expect(supported('x-bogus')).toBe(false);
    expect(supported('Shift_JIS')).toBe(true);
    expect(supported(null)).toBe(true);
  });

  test("WHATWG's replacement labels give one U+FFFD", () => {
    expect(withProblems((s) => decodeText(enc('\x1b$)Ckorean'), 'ISO-2022-KR', s))).toEqual(['\ufffd', []]);
    expect(decodeText(new Uint8Array(0), 'iso-2022-kr', () => {})).toBe('');
  });
});

describe('header blocks', () => {
  const read = (s: string, root = false) => withProblems((sink) => readHeaders(enc(s), 0, enc(s).length, root, sink));

  test('fields, unfolded, names lowercased, offsets', () => {
    const msg = 'Subject: hello\r\n world\r\nX-Two : a\r\n\tb \r\nFrom:x@y\r\n\r\nbody';
    const [block, p] = read(msg);
    expect(p).toEqual(['header-malformed']);   // the space before X-Two's colon
    expect(block.ended).toBe(true);
    expect(block.fields.map((f) => [f.name, f.value])).toEqual([['subject', 'hello world'], ['x-two', 'a\tb'], ['from', 'x@y']]);
    expect(msg.slice(block.bodyStart)).toBe('body');
    const f = block.fields[1]!;
    expect(msg.slice(f.start, f.end)).toBe('X-Two : a\r\n\tb \r\n');
  });

  test('bare LF ends a line, a bare CR does not', () => {
    const [block] = read('A: 1\nB: 2\rC: 3\n\nbody');
    expect(block.fields.map((f) => [f.name, f.value])).toEqual([['a', '1'], ['b', '2\rC: 3']]);
    expect(block.bodyStart).toBe(16);
  });

  test('a block without a blank line runs to the end: ended false, empty body', () => {
    const [block] = read('A: 1\r\nB: 2');
    expect(block.ended).toBe(false);
    expect(block.bodyStart).toBe(10);
    expect(block.fields.length).toBe(2);
  });

  test('an empty block; a line that is not a field is skipped', () => {
    expect(read('\r\nbody')[0]).toEqual({ fields: [], ended: true, bodyStart: 2 });
    const [block] = read('From mbox line\r\n cont\r\nA: 1\r\n:empty\r\n\r\n');
    expect(block.fields.map((f) => f.name)).toEqual(['a']);
  });

  test('UTF-8 field bytes (RFC 6532); invalid ones as windows-1252', () => {
    expect(read('Subject: café\r\n\r\n')[0].fields[0]!.value).toBe('café');
    const bytes = latin('Subject: caf\xe9\r\n\r\n');
    const [block, p] = withProblems((s) => readHeaders(bytes, 0, bytes.length, false, s));
    expect(block.fields[0]!.value).toBe('café');
    expect(p).toEqual(['charset-fallback']);
  });

  test('more than 1,000 fields: the rest dropped, the block still read to its end', () => {
    const msg = Array.from({ length: 1200 }, (_, i) => `X-${i}: v\r\n`).join('') + '\r\nbody';
    const [block, p] = read(msg);
    expect(block.fields.length).toBe(1000);
    expect(block.fields[999]!.name).toBe('x-999');
    expect(p).toEqual(['field-dropped']);
    expect(msg.slice(block.bodyStart)).toBe('body');
  });

  test('size limits: 64 kB for a part, 1 MB for the root', () => {
    const big = 'A: 1\r\nX: ' + 'x'.repeat(70_000) + '\r\nB: 2\r\n\r\nbody';
    const [part, p] = read(big);
    expect(part.fields.map((f) => f.name)).toEqual(['a']);
    expect(p).toEqual(['field-dropped']);
    expect(big.slice(part.bodyStart)).toBe('body');
    const [root, q] = read(big, true);
    expect(root.fields.map((f) => f.name)).toEqual(['a', 'x', 'b']);
    expect(q).toEqual([]);
  });

  test('a 1 MB folded field and a 10 MB block read in linear time', () => {
    const folded = 'Received: ' + 'a\r\n '.repeat(200_000) + '\r\n\r\n';
    const [[block], ms] = timed(() => read(folded, true));
    expect(block.ended).toBe(true);
    expect(ms).toBeLessThan(500);
    const huge = 'X: y\r\n'.repeat(1_700_000) + '\r\n';
    const [, ms2] = timed(() => read(huge, true));
    expect(ms2).toBeLessThan(1000);
  });
});

describe('control removal', () => {
  test('NUL, C0, CR, LF, DEL and bidi controls go; a tab becomes a space', () => {
    expect(clean('a\u0000b\r\nc\u0007d\u007fe\tf')).toBe('abcde f');
    expect(clean('evil\u202efdp.exe\u200e\u200f\u061c\u202a\u202b\u202c\u202d\u2066\u2067\u2068\u2069!')).toBe('evilfdp.exe!');
    expect(clean('ok ü €')).toBe('ok ü €');
  });

  test('hasControl finds structure-breaking controls, not tabs', () => {
    expect(hasControl('multipart/mixed; boundary="a\u0000b"')).toBe(true);
    expect(hasControl('text/plain;\tcharset=utf-8')).toBe(false);
    expect(hasControl('text/plain\r')).toBe(true);
  });
});

describe('encoded words', () => {
  const dw = (s: string) => withProblems((sink) => decodeWords(s, sink));

  test('B and Q, in unstructured text', () => {
    expect(dw('=?utf-8?B?Y2Fmw6k=?=')).toEqual(['café', []]);
    expect(dw('=?ISO-8859-1?Q?caf=E9_au_lait?= ok')).toEqual(['café au lait ok', []]);
    expect(unstructured('Re: =?utf-8?q?hi?= there', () => {})).toBe('Re: hi there');
  });

  test('adjacent words joined without the whitespace between them', () => {
    expect(dw('=?utf-8?q?a?= =?utf-8?q?b?=\r\n =?iso-8859-1?q?c?=')).toEqual(['abc', []]);
    expect(dw('=?utf-8?q?a?= x =?utf-8?q?b?=')).toEqual(['a x b', []]);
  });

  test('a character split across two words of one charset comes out whole', () => {
    // é is C3 A9; split across two B words, and across two Q words
    expect(dw('=?utf-8?B?w4==?= =?utf-8?B?qQ==?=')).toEqual(['é', []]);
    expect(dw('=?utf-8?q?caf=C3?= =?utf-8?q?=A9?=')).toEqual(['café', []]);
    expect(dw('=?utf-8?B?Y2Fmww==?= =?UTF-8?B?qQ==?=')).toEqual(['café', []]);
  });

  test('only a whole whitespace-delimited word is decoded', () => {
    expect(dw('collab=?x?b?QA==?=psres.net')).toEqual(['collab=?x?b?QA==?=psres.net', []]);
    expect(dw('a=?utf-8?q?b?=')).toEqual(['a=?utf-8?q?b?=', []]);
    expect(dw('=?utf-8?q?a?==?utf-8?q?b?=')).toEqual(['=?utf-8?q?a?==?utf-8?q?b?=', []]);
  });

  test('an unknown charset leaves the word as written, charset-unknown', () => {
    expect(dw('=?x?q?abc?=')).toEqual(['=?x?q?abc?=', ['charset-unknown']]);
    expect(dw('=?utf-7?q?abc?= =?utf-8?q?d?=')).toEqual(['=?utf-7?q?abc?= d', ['charset-unknown']]);
  });

  test('language suffixes (RFC 2231) and malformed words', () => {
    expect(dw('=?utf-8*en?q?hi?=')).toEqual(['hi', []]);
    expect(dw('=?utf-8?x?hi?= =?utf-8?q?h i?= =??q?a?=')[0]).toBe('=?utf-8?x?hi?= =?utf-8?q?h i?= =??q?a?=');
    expect(dw('=?utf-8?q?a=ZZ?=')).toEqual(['a=ZZ', ['qp-invalid']]);
  });

  test('decoded controls are removed: no header injection, no NUL (Mailsploit)', () => {
    expect(dw('=?utf-8?q?a=0D=0ABcc:_x@y?=')[0]).toBe('aBcc: x@y');
    expect(dw('=?utf-8?b?cG90dXNAd2hpdGVob3VzZS5nb3YAIDx0ZXN0Pg==?=')[0]).toBe('potus@whitehouse.gov <test>');
    expect(dw('=?utf-8?q?=E2=80=AEtxt.exe?=')[0]).toBe('txt.exe');
  });

  test('caps: 64 per phrase, 4,096 per field, the rest dropped', () => {
    const many = (n: number) => Array.from({ length: n }, () => '=?utf-8?q?a?=').join(' ');
    expect(withProblems((s) => decodeWords(many(70), s, { words: 4096 }, 64))).toEqual(['a'.repeat(64), ['field-dropped']]);
    const [r, p] = withProblems((s) => unstructured(many(5000), s));
    expect(r).toBe('a'.repeat(4096));
    expect(p).toEqual(['field-dropped']);
  });

  test('100,000 encoded words, and hostile near-words, in linear time', () => {
    const words = Array.from({ length: 100_000 }, () => '=?utf-8?q?ab?=').join(' ');
    const [, ms] = timed(() => decodeWords(words, () => {}, { words: 1e9 }, 1e9));
    expect(ms).toBeLessThan(800);
    const [, ms2] = timed(() => unstructured('=?'.repeat(500_000) + '=?a?q?' + 'x'.repeat(500_000), () => {}));
    expect(ms2).toBeLessThan(500);
    const [, ms3] = timed(() => unstructured('=?a?q?b?c?d'.repeat(100_000), () => {}));
    expect(ms3).toBeLessThan(500);
  });
});

describe('parameter fields', () => {
  const pf = (s: string) => withProblems((sink) => { const f = parameterField(s, sink); return { value: f.value, params: f.params }; });

  test('type and parameters, tokens lowercased, values as sent', () => {
    expect(pf('Text/HTML; Charset="UTF-8"; format=flowed')).toEqual([{ value: 'text/html', params: [['charset', 'UTF-8'], ['format', 'flowed']] }, []]);
    expect(pf('multipart/mixed;\r\n\tboundary="----=_Part_1"')[0].params).toEqual([['boundary', '----=_Part_1']]);
    expect(pf('text / plain (comment) ; charset = us-ascii (Plain text)')[0]).toEqual({ value: 'text/plain', params: [['charset', 'us-ascii']] });
    expect(pf('attachment; filename="a\\"b.txt"')[0]).toEqual({ value: 'attachment', params: [['filename', 'a"b.txt']] });
  });

  test('malformed types are empty; junk before parameters skipped', () => {
    expect(pf('text')[0].value).toBe('text');
    expect(pf('text/')[0].value).toBe('');
    expect(pf('/plain')[0].value).toBe('');
    expect(pf('text/plain garbage; charset=x')[0]).toEqual({ value: '', params: [['charset', 'x']] });
    expect(pf('')[0]).toEqual({ value: '', params: [] });
    expect(pf('text/plain; ; noequals; =x; charset=y')[0].params).toEqual([['charset', 'y']]);
  });

  test('unquoted values read leniently to the next ;', () => {
    expect(pf('attachment; filename=my file.txt; size=3')[0].params).toEqual([['filename', 'my file.txt'], ['size', '3']]);
  });

  test('RFC 2231: charsets, continuations, in order', () => {
    expect(pf("attachment; filename*=utf-8''caf%C3%A9.txt")[0].params).toEqual([['filename*', 'café.txt']]);
    expect(pf("attachment; filename*=iso-8859-1'fr'caf%E9.txt")[0].params).toEqual([['filename*', 'café.txt']]);
    expect(pf('attachment; filename*0="long "; filename*1="name.txt"')[0].params).toEqual([['filename*', 'long name.txt']]);
    expect(pf("attachment; filename*0*=utf-8''caf%C3; filename*1*=%A9; filename*2=.txt")).toEqual([{ value: 'attachment', params: [['filename*', 'café.txt']] }, []]);
    // both forms, as Thunderbird sends them
    expect(pf("attachment; filename*=utf-8''a%20b; filename=\"a b\"")[0].params).toEqual([['filename*', 'a b'], ['filename', 'a b']]);
  });

  test('RFC 2231 segments out of order, repeated or missing: joined in order, rfc2231-segments', () => {
    expect(pf('a; n*1="b"; n*0="a"')).toEqual([{ value: 'a', params: [['n*', 'ab']] }, ['rfc2231-segments']]);
    expect(pf('a; n*0="a"; n*0="x"; n*1="b"')).toEqual([{ value: 'a', params: [['n*', 'ab']] }, ['rfc2231-segments']]);
    expect(pf('a; n*0="a"; n*2="c"')).toEqual([{ value: 'a', params: [['n*', 'ac']] }, ['rfc2231-segments']]);
    expect(pf('a; n*1="b"')).toEqual([{ value: 'a', params: [['n*', 'b']] }, ['rfc2231-segments']]);
  });

  test('RFC 2047 words in filename= and name= (Outlook, Gmail), nowhere else', () => {
    expect(pf('attachment; filename="=?UTF-8?B?Y2Fmw6kucGRm?="')[0].params).toEqual([['filename', 'café.pdf']]);
    expect(pf('application/pdf; name==?utf-8?q?caf=C3=A9.pdf?=')[0].params).toEqual([['name', 'café.pdf']]);
    expect(pf('text/plain; charset="=?utf-8?q?x?="')[0].params).toEqual([['charset', '=?utf-8?q?x?=']]);
  });

  test('decoded structure stays text: an encoded quote, ; or CRLF in a filename', () => {
    const [r] = pf('attachment; filename="=?utf-8?q?a=22=3B_filename=3Devil.exe=0D=0AX:_y?="; size=1');
    expect(r.params).toEqual([['filename', 'a"; filename=evil.exeX: y'], ['size', '1']]);
    expect(pf("attachment; filename*=utf-8''a%00b%0D%0Ac")[0].params).toEqual([['filename*', 'abc']]);
  });

  test('duplicates: the first counts; duplicate-parameter for the watched names only', () => {
    expect(pf('multipart/mixed; boundary=a; boundary=b')).toEqual([{ value: 'multipart/mixed', params: [['boundary', 'a']] }, ['duplicate-parameter']]);
    expect(pf('text/plain; CHARSET=a; charset=a')[1]).toEqual(['duplicate-parameter']);
    expect(pf('text/plain; format=a; format=b')).toEqual([{ value: 'text/plain', params: [['format', 'a']] }, []]);
    expect(pf("a; filename*=utf-8''x; filename*0=y")).toEqual([{ value: 'a', params: [['filename*', 'x']] }, ['duplicate-parameter']]);
  });

  test('parameters are pairs: __proto__ is a name like another', () => {
    const [r] = pf('a; __proto__=x; constructor=y');
    expect(r.params).toEqual([['__proto__', 'x'], ['constructor', 'y']]);
  });

  test('a control in a structural field is control-in-structure; the boundary stays as sent', () => {
    expect(pf('multipart/mixed; boundary="a\u0000b"')).toEqual([{ value: 'multipart/mixed', params: [['boundary', 'a\u0000b']] }, ['control-in-structure']]);
  });

  test('hostile parameter fields in linear time', () => {
    const [, ms] = timed(() => parameterField('a; ' + Array.from({ length: 50_000 }, (_, i) => `n*${i % 9000}*=%41`).join('; '), () => {}));
    expect(ms).toBeLessThan(500);
    const [, ms2] = timed(() => parameterField('a; b=' + '('.repeat(200_000) + '"'.repeat(200_000), () => {}));
    expect(ms2).toBeLessThan(500);
  });
});

describe('Message-ID lists', () => {
  test('ids without brackets, in order, comments and phrases skipped', () => {
    expect(messageIds('<a@b>')).toEqual(['a@b']);
    expect(messageIds(' <a@b> (c) <c@d>\t<e\r\n @f>')).toEqual(['a@b', 'c@d', 'e@f']);
    expect(messageIds('"Bob\'s message of <not@id>" <x@y>')).toEqual(['x@y']);
    expect(messageIds('bare@id')).toEqual(['bare@id']);
    expect(messageIds('no id here')).toEqual([]);
    expect(messageIds('<a\u0000b@c>')).toEqual(['ab@c']);
  });
});

describe('addresses', () => {
  const ad = (s: string) => withProblems((sink) => addresses(s, sink));
  const one = (s: string) => ad(s)[0][0];

  test('the common forms', () => {
    expect(ad('a@b.example')).toEqual([[{ name: null, address: 'a@b.example' }], []]);
    expect(ad('Alice Smith <alice@x.example>, "Bob, Jr." <bob@y.example>')[0]).toEqual([
      { name: 'Alice Smith', address: 'alice@x.example' }, { name: 'Bob, Jr.', address: 'bob@y.example' }]);
    expect(ad('<a@b>')[0]).toEqual([{ name: null, address: 'a@b' }]);
    expect(ad('John Q. Public <jqp@x>')[0]).toEqual([{ name: 'John Q. Public', address: 'jqp@x' }]);
  });

  test('obsolete forms: comments anywhere, CFWS around dots, routes, obs-list', () => {
    expect(one('john (the man) . doe @ (c) example . com (John Doe)')).toEqual({ name: 'the man', address: 'john.doe@example.com' });
    expect(one('a@b (Alice)')).toEqual({ name: 'Alice', address: 'a@b' });
    expect(one('Joe <@a.example,@b.example:joe@c.example>')).toEqual({ name: 'Joe', address: 'joe@c.example', suspicious: true });
    expect(ad(', ,a@b,,c@d,')[0].map((a) => a.address)).toEqual(['a@b', 'c@d']);
    // a `;` with no group open: the mailboxes on both sides are null (CVE-2023-27043)
    expect(ad('a@b; c@d')).toEqual([[{ name: null, address: null }, { name: null, address: null }], ['address-ambiguous']]);
    expect(one('"a"."b"@c')).toEqual({ name: null, address: 'a.b@c' });
    expect(one('a..b@docomo.ne.jp')).toEqual({ name: null, address: 'a..b@docomo.ne.jp' });
  });

  test('groups; an empty group is one address with name and address null', () => {
    expect(ad('undisclosed-recipients:;')[0]).toEqual([{ name: null, address: null, group: 'undisclosed-recipients' }]);
    expect(ad('Team: a@b, Bob <c@d>; e@f')[0]).toEqual([
      { name: null, address: 'a@b', group: 'Team' }, { name: 'Bob', address: 'c@d', group: 'Team' }, { name: null, address: 'e@f' }]);
    expect(ad('=?utf-8?q?T=C3=A9am?=: a@b;')[0]).toEqual([{ name: null, address: 'a@b', group: 'Téam' }]);
    expect(ad('Open: a@b')[0]).toEqual([{ name: null, address: 'a@b', group: 'Open' }]);
  });

  test('encoded words decoded in display names, quoted or not, and comments', () => {
    expect(one('=?utf-8?q?Andr=C3=A9?= <a@b>')).toEqual({ name: 'André', address: 'a@b' });
    expect(one('"=?utf-8?B?QW5kcsOp?=" <a@b>')).toEqual({ name: 'André', address: 'a@b' });
    expect(one('a@b (=?utf-8?q?Andr=C3=A9?=)')).toEqual({ name: 'André', address: 'a@b' });
  });

  test('never in an addr-spec; an encoded word in the local part is suspicious', () => {
    expect(one('=?utf-8?q?a=40evil.example?=@good.example')).toEqual({ name: null, address: '=?utf-8?q?a=40evil.example?=@good.example', suspicious: true });
  });

  test('encoded @ , < > in a display name are text, and suspicious (Splitting the email atom)', () => {
    const [r, p] = ad('=?utf-8?q?ceo=40bank=2Eexample_=3Cceo=40bank=2Eexample=3E=2C_x?= <attacker@evil.example>');
    expect(r).toEqual([{ name: 'ceo@bank.example <ceo@bank.example>, x', address: 'attacker@evil.example', suspicious: true }]);
    expect(p).toEqual([]);
    // a `.` in an unquoted Q word splits it when tokenizing; glued atoms and dots are one word again
    expect(one('=?utf-8?q?a.b?= <x@y>').name).toBe('a.b');
    expect(one('"=?utf-8?q?ceo=40bank.example?=" <x@y>')).toEqual({ name: 'ceo@bank.example', address: 'x@y', suspicious: true });
    expect(one('"=?utf-8?q?=22a=40b=22_=3C?=" <x@y>')).toEqual({ name: '"a@b" <', address: 'x@y', suspicious: true });
  });

  test('Mailsploit: an encoded NUL and @ in the addr-spec stay undecoded', () => {
    const [r] = ad('=?utf-8?b?cG90dXNAd2hpdGVob3VzZS5nb3Y=?==?utf-8?Q?=00?==?utf-8?b?cG90dXNAd2hpdGVob3VzZS5nb3Y=?=@mailsploit.com');
    expect(r[0]!.address).toBe('=?utf-8?b?cG90dXNAd2hpdGVob3VzZS5nb3Y=?==?utf-8?Q?=00?==?utf-8?b?cG90dXNAd2hpdGVob3VzZS5nb3Y=?=@mailsploit.com');
    expect(r[0]!.suspicious).toBe(true);
    const [r2] = ad('"=?utf-8?b?cG90dXNAd2hpdGVob3VzZS5nb3Y=?==?utf-8?Q?=00=0A?=" <demo@mailsploit.com>');
    expect(r2[0]!.address).toBe('demo@mailsploit.com');
    expect(r2[0]!.name).not.toContain('\u0000');
  });

  test('decoded CRLF and NUL removed from names (CVE-2024-6923)', () => {
    expect(one('=?utf-8?q?Eve=0D=0ABcc=3A_x=40y=00?= <e@f>')).toEqual({ name: 'EveBcc: x@y', address: 'e@f', suspicious: true });
  });

  test('suspicious unless the name is the address itself', () => {
    expect(one('"Alice@X.example" <alice@x.example>')).toEqual({ name: 'Alice@X.example', address: 'alice@x.example' });
    expect(one(`"'a@b'" <a@b>`)).toEqual({ name: "'a@b'", address: 'a@b' });
    // an unquoted @ in the display name: the grammar cannot read it
    expect(one("'a@b' <a@b>")).toEqual({ name: "'a@b'", address: null, suspicious: true });
    expect(one('"a@b" <c@d>')).toEqual({ name: 'a@b', address: 'c@d', suspicious: true });
    expect(one('"<script>" <c@d>')).toEqual({ name: '<script>', address: 'c@d', suspicious: true });
  });

  test('quoted local parts: unquoted when plain; kept quoted, and suspicious with @ (Nodemailer)', () => {
    expect(one('"john"@x')).toEqual({ name: null, address: 'john@x' });
    expect(one('"a@x y"@b')).toEqual({ name: null, address: '"a@x y"@b', suspicious: true });
    expect(one('"a b"@c')).toEqual({ name: null, address: '"a b"@c' });
    expect(one('"a\\"b"@c')).toEqual({ name: null, address: '"a\\"b"@c' });
    // CRLF or NUL in a quoted local part (MimeKit): null
    expect(ad('"a\r\nBcc: x"@b')).toEqual([[{ name: null, address: null }], ['address-ambiguous']]);
    expect(one('"a\u0000"@b').address).toBe(null);
  });

  test('percent hack, UUCP paths, domain literals are suspicious', () => {
    expect(one('a%evil.example@relay.example')).toEqual({ name: null, address: 'a%evil.example@relay.example', suspicious: true });
    expect(one('host!user@relay.example')).toEqual({ name: null, address: 'host!user@relay.example', suspicious: true });
    expect(one('a@[192.0.2.1]')).toEqual({ name: null, address: 'a@[192.0.2.1]', suspicious: true });
    expect(one('a@[x@y]').address).toBe(null);
  });

  test('ambiguous addr-specs are null, never a guess', () => {
    const nulls = [
      'alice@example.org)<bob@example.org>',     // CVE-2023-27043
      'alice@example.org <bob@example.org>',     // an addr-spec where the display name goes
      'a@b@c',
      'a b@c',
      '<a@b> <c@d>',
      '<a@b',
      'a@b>',
      'Joe <a@b> trailing',
      '<a@>',
      '<@b>',
      '<>',
      'a@b..c',
      'a@.b',
      'a@b.',
      'a@"b"',
      'a@b (unterminated',
      '"unterminated@b',
      'x <a@b:c@d>',
      '<a@b.example\\>',
      'a@b/c',
      'a@b%41',
      'a@0x7f.1',
    ];
    for (const s of nulls) {
      const [r, p] = ad(s);
      expect(r.length, s).toBeGreaterThan(0);
      expect(r.map((a) => a.address), s).toEqual([null]);
      expect(p, s).toContain('address-ambiguous');
    }
    // the domain is never truncated (postal-mime before 4.2.1)
    expect(ad('a@evil.example\u0000.good.example')[0].map((a) => a.address)).toEqual([null]);
    expect(one('Name <user@evil.example,@good.example>').address).toBe(null);
  });

  test('words without an addr-spec: a name, address null', () => {
    expect(ad('undisclosed-recipients')).toEqual([[{ name: 'undisclosed-recipients', address: null }], ['address-ambiguous']]);
  });

  test('comments nested past 8 make the mailbox unreadable; 8 is fine', () => {
    expect(one('a@b ' + '('.repeat(8) + 'x' + ')'.repeat(8)).address).toBe('a@b');
    expect(one('a@b ' + '('.repeat(9) + 'x' + ')'.repeat(9)).address).toBe(null);
  });

  test('Unicode beyond Latin-1 is never truncated to ASCII (U+0140, U+FF20, U+3002)', () => {
    // U+0140 has 0x40 (`@`) as its low byte, U+0122 has 0x22 (`"`), U+013C has 0x3c (`<`)
    expect(one('J\u0140n \u0122x\u013C <j\u0140n@x.example>')).toEqual({ name: 'J\u0140n \u0122x\u013C', address: 'j\u0140n@x.example' });
    expect(ad('a\u0140evil.example')).toEqual([[{ name: 'a\u0140evil.example', address: null }], ['address-ambiguous']]);
    // a full-width @ is not an @; a U+3002 is not a dot to the reader, and URL would make it one: null
    expect(one('a\uff20b').address).toBe(null);
    expect(one('a@b\u3002example').address).toBe(null);
    expect(one('a@\uff45xample.com').address).toBe(null);
  });

  test('IDN: U-labels kept as written; invalid A-labels null', () => {
    expect(one('a@bücher.example')).toEqual({ name: null, address: 'a@bücher.example' });
    expect(one('a@xn--bcher-kva.example')).toEqual({ name: null, address: 'a@xn--bcher-kva.example' });
    expect(one('a@xn--zz.example').address).toBe(null);
    expect(one('a@xn--a.example').address).toBe(null);
  });

  test('at most 1,000 addresses per field', () => {
    const [r, p] = ad(Array.from({ length: 1500 }, (_, i) => `u${i}@x`).join(', '));
    expect(r.length).toBe(1000);
    expect(p).toEqual(['field-dropped']);
  });

  test('hostile lists in linear time: 10,000 nested comments, 1 MB of brackets, many words', () => {
    const [r, ms] = timed(() => addresses('a@b ' + '('.repeat(10_000) + ')'.repeat(10_000), () => {}));
    expect(r[0]!.address).toBe(null);
    expect(ms).toBeLessThan(300);
    const [, ms2] = timed(() => addresses('<'.repeat(1_000_000), () => {}));
    expect(ms2).toBeLessThan(800);
    const [, ms3] = timed(() => addresses('a'.repeat(1_000_000) + '@' + 'b.'.repeat(100_000) + 'c', () => {}));
    expect(ms3).toBeLessThan(800);
    const [, ms4] = timed(() => addresses(Array.from({ length: 100_000 }, () => '=?utf-8?q?a?=').join(' ') + ' <a@b>', () => {}));
    expect(ms4).toBeLessThan(800);
    const [, ms5] = timed(() => addresses('"\\'.repeat(300_000) + ',' + ':'.repeat(100_000), () => {}));
    expect(ms5).toBeLessThan(800);
  });

  test('the comparison: ASCII case-insensitive, domains as A-labels, null never matches', () => {
    expect(sameAddress('Alice@Example.COM', 'alice@example.com')).toBe(true);
    expect(sameAddress('a@BÜCHER.example', 'A@xn--bcher-kva.example')).toBe(true);
    expect(sameAddress('ä@x', 'Ä@x')).toBe(false);
    // no NFC: precomposed and decomposed differ
    expect(sameAddress('\u00e9@x', 'e\u0301@x')).toBe(false);
    expect(sameAddress(null, null)).toBe(false);
    expect(sameAddress('a@b', null)).toBe(false);
    expect(sameAddress('a@b', 'a@c')).toBe(false);
    expect(addressKey('"a@x"@B')).toBe('"a@x"@b');
    expect(addressKey('a@[IPv6:X]')).toBe('a@[ipv6:x]');
    expect(addressKey('a@b/c')).toBe(null);
  });
});

describe('dates', () => {
  test('RFC 5322 dates in the sender offset', () => {
    expect(parseDate('Tue, 24 Nov 2026 09:30:00 +0100')).toBe('2026-11-24T09:30:00+01:00');
    expect(parseDate('24 Nov 2026 09:30:00 -0530')).toBe('2026-11-24T09:30:00-05:30');
    expect(parseDate('Tue, 24 Nov 2026 09:30:00 +0000')).toBe('2026-11-24T09:30:00+00:00');
  });

  test('obsolete forms', () => {
    expect(parseDate('Tue, 24 Nov 26 09:30 EST')).toBe('2026-11-24T09:30:00-05:00');
    expect(parseDate('Wed, 1 Jan 99 23:59:59 PDT')).toBe('1999-01-01T23:59:59-07:00');
    expect(parseDate('1 Jan 049 00:00 GMT')).toBe('1949-01-01T00:00:00+00:00');
    expect(parseDate('  Tue ,  24   Nov   2026   9:05:07   UT  ')).toBe('2026-11-24T09:05:07+00:00');
    expect(parseDate('Tue, 24 (comment (nested)) Nov 2026 09:30:00 +0100 (CET)')).toBe('2026-11-24T09:30:00+01:00');
    expect(parseDate('Tue, 24 Nov 2026 09:30:00 Z')).toBe('2026-11-24T09:30:00+00:00');
    expect(parseDate('Tue, 24 Nov 2026 09:30:00 A')).toBe('2026-11-24T09:30:00-00:00');
    expect(parseDate('Tue, 24 Nov 2026 09:30:00 CEST')).toBe('2026-11-24T09:30:00-00:00');
    expect(parseDate('Tue, 24 Nov 2026 09:30:00')).toBe('2026-11-24T09:30:00-00:00');
    expect(parseDate('Tue, 24 Nov 2026 09:30:00 -0000')).toBe('2026-11-24T09:30:00-00:00');
    expect(parseDate('24-Nov-2026 09:30:00 +01:00')).toBe('2026-11-24T09:30:00+01:00');
    expect(parseDate('Tuesday, 24 November 2026 09:30 +0100')).toBe('2026-11-24T09:30:00+01:00');
    expect(parseDate('tue, 24 nov 2026 09:30:00 cst')).toBe('2026-11-24T09:30:00-06:00');
  });

  test('a disagreeing day of the week is ignored', () => {
    expect(parseDate('Fri, 24 Nov 2026 09:30:00 +0100')).toBe('2026-11-24T09:30:00+01:00');
  });

  test('day-of-month ranges with leap years', () => {
    expect(parseDate('29 Feb 2024 00:00 +0000')).toBe('2024-02-29T00:00:00+00:00');
    expect(parseDate('29 Feb 2000 00:00 +0000')).toBe('2000-02-29T00:00:00+00:00');
    expect(parseDate('29 Feb 2026 00:00 +0000')).toBe(null);
    expect(parseDate('29 Feb 1900 00:00 +0000')).toBe(null);
    expect(parseDate('31 Apr 2026 00:00 +0000')).toBe(null);
    expect(parseDate('31 Dec 2026 00:00 +0000')).toBe('2026-12-31T00:00:00+00:00');
    expect(parseDate('0 Dec 2026 00:00 +0000')).toBe(null);
  });

  test('unparseable is null', () => {
    for (const s of ['', 'yesterday', 'Tue, 24 Foo 2026 09:30 +0100', '24 Nov 2026', '24 Nov 2026 24:00 +0000', '24 Nov 2026 09:60 +0000',
      '24 Nov 2026 09:30:61 +0000', '24 Nov 2026 09:30 +2400', '24 Nov 2026 09:30 +0160', '24 Nov 1899 09:30 +0000', '24 Nov 12026 09:30 +0000',
      '2026-11-24T09:30:00Z', 'Constructor, 24 Nov 2026 09:30 +0000', '24 Nov 2026 09:30 +', '24 Nov 2026 09:30 +12345'])
      expect(parseDate(s), s).toBe(null);
    expect(parseDate('24 Nov 2026 09:30 constructor')).toBe('2026-11-24T09:30:00-00:00');
  });

  test('hostile dates in linear time', () => {
    const [, ms] = timed(() => parseDate('('.repeat(1_000_000)));
    const [, ms2] = timed(() => parseDate('1 '.repeat(500_000)));
    expect(ms + ms2).toBeLessThan(500);
  });
});

describe('filenames', () => {
  const fn = (d: [string, string][], t: [string, string][] = []) => { const r = filename(d, t); return { filename: r.filename, originalFilename: r.originalFilename }; };

  test('precedence: filename*, filename, name*, name', () => {
    expect(fn([['filename', 'b.txt'], ['filename*', 'a.txt']], [['name', 'c.txt']]).filename).toBe('a.txt');
    expect(fn([['filename', 'b.txt']], [['name', 'c.txt']]).filename).toBe('b.txt');
    expect(fn([], [['name', 'c.txt'], ['name*', 'd.txt']]).filename).toBe('d.txt');
    expect(fn([], [['name', 'c.txt']]).filename).toBe('c.txt');
    expect(fn([], [])).toEqual({ filename: 'attachment', originalFilename: null });
  });

  test('path separators, :, controls and bidi controls removed; originalFilename keeps the name, controls aside', () => {
    expect(fn([['filename', '../../etc/passwd']])).toEqual({ filename: 'etcpasswd', originalFilename: '../../etc/passwd' });
    expect(fn([['filename', 'C:\\Windows\\x.dll']]).filename).toBe('CWindowsx.dll');
    expect(fn([['filename', 'evil\u202efdp.exe']])).toEqual({ filename: 'evilfdp.exe', originalFilename: 'evilfdp.exe' });
    expect(fn([['filename', 'a\u0000b\u0085c\u2066.txt']]).filename).toBe('abc.txt');
  });

  test('leading dots, trailing dots and spaces', () => {
    expect(safeName('...bashrc')).toBe('bashrc');
    expect(safeName(' .htaccess')).toBe('htaccess');
    expect(safeName('report.exe. . ')).toBe('report.exe');
    expect(safeName('....')).toBe('attachment');
    expect(safeName('')).toBe('attachment');
  });

  test('Windows reserved names get _', () => {
    for (const n of ['CON', 'con.txt', 'Nul.tar.gz', 'COM1', 'lpt9.doc', 'aux .txt', 'COM\u00b9.txt']) expect(safeName(n), n).toBe('_' + n);
    for (const n of ['CONSOLE.txt', 'icon.png', 'COM10']) expect(safeName(n), n).toBe(n);
  });

  test('at most 255 characters, the extension kept, no surrogate pair split', () => {
    const long = safeName('a'.repeat(300) + '.pdf');
    expect(long.length).toBe(255);
    expect(long.endsWith('a.pdf')).toBe(true);
    const emoji = safeName('😀'.repeat(200) + '.txt');
    expect(emoji.length).toBeLessThanOrEqual(255);
    expect(emoji.endsWith('😀.txt')).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji)).toBe(false);
    // the cut falls inside a pair: one unit less; one character earlier, it does not
    expect(safeName('😀'.repeat(200) + '.txt').length).toBe(254);
    expect(safeName('x' + '😀'.repeat(200) + '.txt').length).toBe(255);
    expect(safeName('a'.repeat(300)).length).toBe(255);
    expect(safeName('a.' + 'b'.repeat(300)).length).toBe(255);
  });
});

describe('SHA-256', () => {
  const h = (s: string | Uint8Array) => hex(sha256(typeof s === 'string' ? latin(s) : s));

  test('NIST vectors', () => {
    expect(h('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(h('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(h('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(h('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'))
      .toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
    expect(h(new Uint8Array(1_000_000).fill(0x61))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  test('agrees with node:crypto at every length around the block, in chunks', () => {
    const data = new Uint8Array(300).map((_, i) => (i * 131 + 7) & 255);
    for (let n = 0; n <= 300; n++) {
      const want = createHash('sha256').update(data.subarray(0, n)).digest('hex');
      expect(hex(sha256(data.subarray(0, n))), String(n)).toBe(want);
      const cut = (n * 7) % (n + 1);
      expect(hex(sha256(data.subarray(0, cut), new Uint8Array(0), data.subarray(cut, n))), `${n} split`).toBe(want);
    }
  });

  test('step digests', () => {
    const c = enc('ciphertext');
    expect(stepDigest(c)).toBe(createHash('sha256').update(c).digest('hex').slice(0, 32));
    const signed = enc('signed bytes'), sig = enc('signature');
    const want = createHash('sha256').update(Buffer.from([0, 0, 0, 12])).update(signed).update(sig).digest('hex').slice(0, 32);
    expect(verifyDigest(signed, sig)).toBe(want);
    // the length binds the split: the same concatenation split elsewhere differs
    expect(verifyDigest(enc('signed byte'), enc('ssignature'))).not.toBe(want);
  });
});

describe('image types', () => {
  const b = (...xs: (number | string)[]) => Uint8Array.from(xs.flatMap((x) => typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x]));
  const box = (major: string, ...compat: string[]) => {
    const size = 16 + compat.length * 4;
    return b(0, 0, 0, size, 'ftyp', major, 0, 0, 0, 0, ...compat, 0, 0);
  };

  test('by magic number', () => {
    expect(imageType(b(0x89, 'PNG\r\n', 0x1a, '\n', 0, 0))).toBe('png');
    expect(imageType(b(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(imageType(b('GIF87a'))).toBe('gif');
    expect(imageType(b('GIF89a', 1))).toBe('gif');
    expect(imageType(b('RIFF', 0, 0, 0, 0, 'WEBPVP8 '))).toBe('webp');
    expect(imageType(box('avif'))).toBe('avif');
    expect(imageType(box('avis'))).toBe('avif');
    expect(imageType(box('mif1', 'miaf', 'avif'))).toBe('avif');
  });

  test('anything else is null, SVG always', () => {
    expect(imageType(enc('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(null);
    expect(imageType(enc('<?xml version="1.0"?><svg/>'))).toBe(null);
    expect(imageType(b('GIF88a'))).toBe(null);
    expect(imageType(b('RIFF', 0, 0, 0, 0, 'WAVE'))).toBe(null);
    expect(imageType(box('heic', 'mif1'))).toBe(null);
    expect(imageType(b(0, 0, 0, 8, 'ftypavif'))).toBe(null);
    // a compatible brand past the box's size does not count
    expect(imageType(b(0, 0, 0, 16, 'ftyp', 'mif1', 0, 0, 0, 0, 'avif'))).toBe(null);
    expect(imageType(b(0x89, 'PNG'))).toBe(null);
    expect(imageType(new Uint8Array(0))).toBe(null);
  });
});


describe('the second round of rules', () => {
  const read = (s: string) => withProblems((sink) => readHeaders(enc(s), 0, enc(s).length, false, sink));

  test('header-malformed: no colon, space before colon, leading continuation, whitespace-only line; once per block', () => {
    expect(read('A: 1\r\nno colon\r\n\r\n')).toEqual([{ fields: [{ name: 'a', value: '1', start: 0, end: 6 }], ended: true, bodyStart: 18 }, ['header-malformed']]);
    const [b1, p1] = read('Content-Type : text/plain\r\n\r\n');
    expect(b1.fields.map((f) => [f.name, f.value])).toEqual([['content-type', 'text/plain']]);
    expect(p1).toEqual(['header-malformed']);
    const [b2, p2] = read(' leading\r\nA: 1\r\n\r\n');
    expect(b2.fields.map((f) => f.name)).toEqual(['a']);
    expect(p2).toEqual(['header-malformed']);
    const [b3, p3] = read('A: 1\r\n   \r\nB: 2\r\n\r\nbody');
    expect(b3.fields.map((f) => [f.name, f.value])).toEqual([['a', '1'], ['b', '2']]);
    expect(b3.ended).toBe(true);
    expect(p3).toEqual(['header-malformed']);
    expect(read('A: 1\r\nB: 2\r\n\r\n')[1]).toEqual([]);
    expect(read('Xé: 1\r\n\r\n')[1]).toEqual(['header-malformed']);
  });

  test('headers that run to the part end: ended false, nothing reported here', () => {
    expect(read('Content-Type: text/plain\n')).toEqual([{ fields: [{ name: 'content-type', value: 'text/plain', start: 0, end: 25 }], ended: false, bodyStart: 25 }, []]);
  });

  test('control-in-structure: a control in a field name, in MIME-Version, in Content-Transfer-Encoding', () => {
    const [b, p] = read('Con\u0000tent-Type: text/html\r\nA: 1\r\n\r\n');
    expect(b.fields.map((f) => f.name)).toEqual(['a']);
    expect(p).toContain('control-in-structure');
    expect(read('MIME-Version: 1.0\u0000\r\n\r\n')[1]).toEqual(['control-in-structure']);
    expect(withProblems((s) => transferEncoding('base\u000064', s))[1]).toEqual(['control-in-structure']);
  });

  test('Content-Type that cannot be read: text/plain; charset=us-ascii, content-type-invalid', () => {
    for (const v of ['text', 'text/', '/html', 'text/html garbage', '', '"text/html"'])
      expect(withProblems((s) => contentType(v, s)), v).toEqual([{ value: 'text/plain', params: [['charset', 'us-ascii']], encoded: [], conflicts: [] }, ['content-type-invalid']]);
    expect(withProblems((s) => contentType('Text/HTML (c); charset=x', s))).toEqual([{ value: 'text/html', params: [['charset', 'x']], encoded: [], conflicts: [] }, []]);
  });

  test('Content-Transfer-Encoding: the ASCII token, case-insensitive, whitespace removed; a comment, quotes or trailing text is null', () => {
    expect(transferEncoding(' Base64\t', () => {})).toBe('base64');
    for (const v of [' (c) Base64 (d) ', 'base64 (c)', '(c)base64', 'base64;', 'basé64', 'base64\u00a0'])
      expect(transferEncoding(v, () => {}), v).toBe(null);
    expect(transferEncoding('Quoted-Printable', () => {})).toBe('quoted-printable');
    expect(transferEncoding('"base64"', () => {})).toBe(null);
    expect(transferEncoding('base64 x', () => {})).toBe(null);
    expect(transferEncoding('base64; x', () => {})).toBe(null);
    expect(transferEncoding('', () => {})).toBe(null);
  });

  test('encoded words in parameters: decoded in filename/name, literal elsewhere, encoded-word-in-parameter', () => {
    const [f, p] = withProblems((s) => parameterField('multipart/mixed; boundary="=?utf-8?q?x?="; name="=?utf-8?q?a?="', s));
    expect(f.params).toEqual([['boundary', '=?utf-8?q?x?='], ['name', 'a']]);
    expect(f.encoded).toEqual(['boundary', 'name']);
    expect(p).toEqual(['encoded-word-in-parameter', 'encoded-word-in-parameter']);
    expect(parameterField('a; filename="x=?utf-8?q?y?=.txt"', () => {}).encoded).toEqual([]);
  });

  test('parameter-conflict: x beside x* with another value, two spellings with another value; names returned', () => {
    const [f, p] = withProblems((s) => parameterField("attachment; filename=\"a.txt\"; filename*=utf-8''b.exe", s));
    expect(f.conflicts).toEqual(['filename']);
    expect(p).toEqual(['parameter-conflict']);
    expect(parameterField("attachment; filename=\"a b\"; filename*=utf-8''a%20b", () => {}).conflicts).toEqual([]);
    const [g, q] = withProblems((s) => parameterField('multipart/signed; Micalg=pgp-sha1; micalg=pgp-sha256', s));
    expect(g.params).toEqual([['micalg', 'pgp-sha1']]);
    expect(g.conflicts).toEqual(['micalg']);
    expect(q).toEqual(['duplicate-parameter', 'parameter-conflict']);
    for (const n of ['start', 'type', 'micalg']) expect(withProblems((s) => parameterField(`a; ${n}=x; ${n}=x`, s))[1], n).toEqual(['duplicate-parameter']);
  });

  test('filename conflicts: filename*, filename, name differing are reported and named', () => {
    const [r, p] = withProblems((s) => filename([['filename', 'invoice.pdf'], ['filename*', 'invoice.pdf.exe']], [['name', 'x.pdf']], s));
    expect(r).toEqual({ filename: 'invoice.pdf.exe', originalFilename: 'invoice.pdf.exe', conflicts: ['filename*', 'filename', 'name'] });
    expect(p).toEqual(['parameter-conflict']);
    expect(withProblems((s) => filename([['filename', 'a']], [['name', 'a']], s))).toEqual([{ filename: 'a', originalFilename: 'a', conflicts: [] }, []]);
  });

  test('quoted-printable: = before a bare CR is literal; = as the last byte dropped, both qp-invalid', () => {
    const qp = (s: string) => withProblems((sink) => str(quotedPrintable(enc(s), 0, enc(s).length, sink)));
    expect(qp('a=\rb\r\n')).toEqual(['a=\rb\r\n', ['qp-invalid']]);
    expect(qp('end=')).toEqual(['end', ['qp-invalid']]);
    expect(qp('end= \t')).toEqual(['end', ['qp-invalid']]);
    expect(qp('soft= \t\r\nbreak')).toEqual(['softbreak', []]);
  });

  test('base64: padding mid-stream is told apart from other junk', () => {
    const r = (s: string) => base64Result(latin(s), 0, s.length, () => {});
    expect(r('aGk=dGhlcmU=').midPadding).toBe(true);
    expect(r('aGk*').midPadding).toBe(false);
    expect(r('aGk=\r\n').midPadding).toBe(false);
  });

  test('encoded words: a whole atom bounded by a special counts; glued inside an atom does not', () => {
    expect(addresses('=?utf8?q?=61=62=63?=<collab@psres.net>', () => {})).toEqual([{ name: 'abc', address: 'collab@psres.net' }]);
    expect(addresses('"=?utf-8?q?a?=""=?utf-8?q?b?=" <x@y>', () => {})[0]!.name).toBe('ab');
    expect(addresses('x=?utf-8?q?a?= <x@y>', () => {})[0]!.name).toBe('x=?utf-8?q?a?=');
    expect(addresses('collab=?x?b?QA==?=psres.net <x@y>', () => {})).toEqual([{ name: 'collab=?x?b?QA==?=psres.net', address: 'x@y' }]);
  });

  test('inside encoded words: invalid UTF-8 falls back to windows-1252; spaces or ? in the text make no word', () => {
    expect(withProblems((s) => decodeWords('=?utf-8?q?caf=E9?=', s))).toEqual(['café', ['charset-fallback']]);
    expect(decodeWords('=?utf-8?q?a b?=', () => {})).toBe('=?utf-8?q?a b?=');
    expect(decodeWords('=?utf-8?q?a?b?=', () => {})).toBe('=?utf-8?q?a?b?=');
  });

  test('addresses: =?…?= in the local part is suspicious, in the domain null', () => {
    expect(addresses('=?utf-8?q?x?=@b.example', () => {})).toEqual([{ name: null, address: '=?utf-8?q?x?=@b.example', suspicious: true }]);
    expect(addresses('"=?utf-8?q?x?="@b.example', () => {})[0]!.suspicious).toBe(true);
    expect(addresses('a@=?utf-8?q?x?=.example', () => {})[0]!.address).toBe(null);
  });

  test('addresses: !, %, @ in the local part suspicious quoted or not; a backslash outside quotes is null', () => {
    for (const a of ['"a!b"@c', '"a%b"@c', 'a!b@c', 'a%b@c', '"a@b"@c']) expect(addresses(a, () => {})[0]!.suspicious, a).toBe(true);
    for (const a of ['a\\@b@c', 'Name\\ <a@b>', '<a\\b@c>']) expect(addresses(a, () => {})[0]!.address, a).toBe(null);
  });

  test('punycode: strict RFC 3492 with overflow checks', () => {
    expect(punycode('bcher-kva')).toBe('bücher');
    expect(punycode('mnchen-3ya')).toBe('münchen');
    expect(punycode('ihqwcrb4cv8a8dqg056pqjye')).toBe('他们为什么不说中文');
    expect(punycode('zz9999999999999')).toBe(null);
    expect(punycode('99999999999999999999')).toBe(null);
    expect(punycode('a-é')).toBe(null);
    expect(punycode('abc-')).toBe('abc');
    expect(punycode('a')).toBe('\u0080');
    expect(punycode('-')).toBe(null);
    expect(punycode('\u0010\u0011')).toBe(null);
    expect(punycode('\u00e9')).toBe(null);
  });

  test('A-labels: invalid, ASCII-only, a special decoded, or not round-tripping give null; kept as transported', () => {
    expect(addresses('a@XN--BCHER-KVA.example', () => {})[0]!.address).toBe('a@XN--BCHER-KVA.example');
    expect(sameAddress('a@XN--BCHER-KVA.example', 'a@bücher.example')).toBe(true);
    for (const d of ['xn--abc-', 'xn--zz9999999999999', 'xn--a_b', 'xn--40a', 'xn--bcher-kva-', 'xn--Bcher-kva'.replace('B', 'ß')])
      expect(addresses(`a@${d}.example`, () => {})[0]!.address, d).toBe(null);
    // a label that decodes to an `@` (punycode of "a@b" with a non-ASCII char) is refused
    expect(addresses('a@xn--a@b-.example', () => {})[0]!.address).toBe(null);
  });

  test('NFKC: a full-width or small @ or < in a display name is suspicious', () => {
    for (const n of ['ceo＠bank.example', 'ceo﹫bank.example', '＜ceo', '﹤ceo'])
      expect(addresses(`"${n}" <x@y>`, () => {})[0]!.suspicious, n).toBe(true);
    expect(addresses('"Ceo" <x@y>', () => {})[0]!.suspicious).toBeUndefined();
  });

  test('no narrowing to bytes: ŀ (U+0140), ❀ (U+2740), ✼ (U+273C) stay whole in names and local parts', () => {
    expect(addresses('ŀ❀✼ <ŀ❀✼@x.example>', () => {})).toEqual([{ name: 'ŀ❀✼', address: 'ŀ❀✼@x.example' }]);
    expect(addresses('"❀@✼" <aŀb@x.example>', () => {})).toEqual([{ name: '❀@✼', address: 'aŀb@x.example', suspicious: true }]);
    expect(addresses('=?utf-8?q?=C5=80=E2=9D=80?= <a@b>', () => {})[0]!.name).toBe('ŀ❀');
    // U+0140 is not `@`, U+273C is not `<`, U+2740 is not `@`
    expect(addresses('aŀb', () => {})[0]!.address).toBe(null);
    expect(addresses('✼a@b✾', () => {})[0]).toEqual({ name: null, address: '✼a@b✾' });
  });
});

describe('the security review', () => {
  const ad = (s: string) => withProblems((sink) => addresses(s, sink));
  const pf = (s: string) => withProblems((sink) => { const f = parameterField(s, sink); return { value: f.value, params: f.params }; });

  test('never throws: 600 kB phrases of encoded words or blank quoted strings, in display and group names', () => {
    const [r1] = ad('"' + '=?a?q??= '.repeat(62_798) + '" <a@b.com>');
    expect(r1[0]!.address).toBe('a@b.com');
    const [r2] = ad('=?utf-8?q?a?= ' + '"" '.repeat(150_000) + '<a@b.com>');
    expect(r2).toEqual([{ name: 'a', address: 'a@b.com' }]);
    const [r3] = ad('=?utf-8?q?a?= ' + '"" '.repeat(150_000) + ':;');
    expect(r3).toEqual([{ name: null, address: null, group: 'a' }]);
    const [r4] = ad('"' + '=?a?q??= '.repeat(62_798) + '": b@c.com;');
    expect(r4[0]!.address).toBe('b@c.com');
    expect(() => addresses('=?utf-8?q?a?=' + '""'.repeat(200_000) + '<a@b.com>', () => {})).not.toThrow();
    expect(() => unstructured('=?utf-8?q?a?= ' + ' '.repeat(1_000_000) + 'x', () => {})).not.toThrow();
  });

  test('CVE-2023-27043: an invalid group phrase nulls its members; a stray ; nulls both sides', () => {
    expect(ad('alice@example.org:<bob@example.org>')).toEqual([[
      { name: 'alice@example.org', address: null, suspicious: true },
      { name: null, address: null, group: 'alice@example.org', suspicious: true }], ['address-ambiguous']]);
    expect(ad('alice@example.org;<bob@example.org>')).toEqual([[{ name: null, address: null }, { name: null, address: null }], ['address-ambiguous']]);
    // the members up to the `;` only
    expect(ad('a@b: c@d, e@f; g@h')[0].map((a) => a.address)).toEqual([null, null, null, 'g@h']);
    // a group's own `;` is not stray; a second one is
    expect(ad('T: a@b; c@d')[0].map((a) => a.address)).toEqual(['a@b', 'c@d']);
    expect(ad('T: a@b;; c@d')[0].map((a) => a.address)).toEqual(['a@b', null]);
    expect(ad('a@b, c@d; e@f, g@h')[0].map((a) => a.address)).toEqual(['a@b', null, null, 'g@h']);
  });

  test('group names are suspicious by the display-name rule', () => {
    expect(ad('"ceo@corp.example": attacker@evil.example;')[0]).toEqual([
      { name: null, address: 'attacker@evil.example', group: 'ceo@corp.example', suspicious: true }]);
    expect(ad('=?utf-8?q?ceo=40corp.example?=: attacker@evil.example;')[0][0]!.suspicious).toBe(true);
    expect(ad('"\uff1cceo": ;')[0]).toEqual([{ name: null, address: null, group: '\uff1cceo', suspicious: true }]);
    expect(ad('"a@b.example": a@b.example;')[0]).toEqual([{ name: null, address: 'a@b.example', group: 'a@b.example' }]);
    expect(ad('Team: a@b;')[0][0]!.suspicious).toBeUndefined();
  });

  test('structural parameters that are not a clean token or quoted string: parameter-malformed, read as before', () => {
    const cases: [string, [string, string][]][] = [
      ['multipart/mixed; boundary=foo bar', [['boundary', 'foo bar']]],
      ['multipart/mixed; boundary=foo(c)bar', [['boundary', 'foobar']]],
      ['multipart/mixed; boundary=(c)foo', [['boundary', 'foo']]],
      ['multipart/mixed; boundary="a"b; x=1', [['boundary', 'a'], ['x', '1']]],
      ['multipart/mixed; boundary="a" (c)', [['boundary', 'a']]],
      ['multipart/mixed; boundary="abc; charset=x', [['boundary', 'abc; charset=x']]],
      ['multipart/mixed; boundary=a"b;c"', [['boundary', 'a"b']]],
      ['multipart/signed; micalg=pgp-sha256 x; protocol="application/pgp-signature"', [['micalg', 'pgp-sha256 x'], ['protocol', 'application/pgp-signature']]],
      ['text/plain; charset=utf-8é', [['charset', 'utf-8é']]],
      // `=` is a tspecial: no token unquoted
      ['multipart/mixed; boundary=----=_Part_1', [['boundary', '----=_Part_1']]],
      ['multipart/mixed; (a comment) boundary=x', [['boundary', 'x']]],
      ['multipart/related; start=<a@b> x; type=text/html', [['start', '<a@b> x'], ['type', 'text/html']]],
      // a comment hides a parameter from a parser that skips none
      ['multipart/mixed; (boundary=a;) boundary=b', [['boundary', 'b']]],
      ['multipart/mixed; x=(; boundary=a) y; boundary=b', [['x', 'y'], ['boundary', 'b']]],
    ];
    for (const [v, params] of cases) expect(pf(v), v).toEqual([{ value: v.slice(0, v.indexOf(';')), params }, ['parameter-malformed']]);
    // clean ones, and the lenient names
    for (const v of ['multipart/mixed; boundary="a b"', 'multipart/mixed; boundary=simple_boundary-1.x', 'multipart/mixed; boundary = x',
      'attachment; filename=my file.txt', 'attachment; filename=a (c).txt',
      // RFC 2045's own example: a comment beside a clean charset
      'text/plain; charset = us-ascii (Plain text)'])
      expect(pf(v)[1], v).toEqual([]);
  });

  test('type/subtype: a comment inside or a non-ASCII character is content-type-invalid', () => {
    for (const v of ['text/(c)html', 'text(c)/html', 'text/ (c) html', 'téxt/html; charset=x', 'text/htéml'])
      expect(withProblems((s) => contentType(v, s))[1], v).toEqual(['content-type-invalid']);
    expect(withProblems((s) => contentType('(c) text / html (c); charset=x', s))).toEqual([{ value: 'text/html', params: [['charset', 'x']], encoded: [], conflicts: [] }, []]);
  });

  test('RFC 2231: forms of a structural name are parameter-malformed; repeated sections duplicate-parameter when watched', () => {
    expect(pf("multipart/mixed; boundary*=utf-8''a%62")).toEqual([{ value: 'multipart/mixed', params: [['boundary*', 'ab']] }, ['parameter-malformed']]);
    expect(pf('multipart/mixed; boundary*0=a; boundary*1=b')).toEqual([{ value: 'multipart/mixed', params: [['boundary*', 'ab']] }, ['parameter-malformed']]);
    expect(pf('multipart/mixed; boundary*0=a; boundary*0=b')).toEqual([{ value: 'multipart/mixed', params: [['boundary*', 'a']] }, ['parameter-malformed', 'duplicate-parameter']]);
    expect(pf('text/plain; charset*=utf-8')[1]).toEqual(['parameter-malformed']);
    expect(pf('a; filename*0=a; filename*0=x; filename*1=b')).toEqual([{ value: 'a', params: [['filename*', 'ab']] }, ['duplicate-parameter']]);
    expect(pf('a; name*1=b; name*0=a')).toEqual([{ value: 'a', params: [['name*', 'ab']] }, ['rfc2231-segments']]);
    // a leading zero is no section 0: dropped, a malformed segment
    expect(pf('a/b; filename*00=a; filename*1=b')).toEqual([{ value: 'a/b', params: [['filename*', 'b']] }, ['rfc2231-segments']]);
    expect(pf('a/b; filename*0=a; filename*01=b')).toEqual([{ value: 'a/b', params: [['filename*', 'a']] }, ['rfc2231-segments']]);
  });

  test('a control, C1, bidi, Unicode space or format character, or a lone surrogate in the local part: null', () => {
    for (const lp of ['a\u0000b', 'a\u0001b', 'a\u007fb', 'a\u0085b', 'a\u202egro.elpmaxe', 'ceo\u200b', 'a\u00a0b', 'a\u2000b', 'a\u2028b',
      'a\u2029b', '\ufeffa', 'a\u00adb', 'a\ud800b', 'a\udc00b', '"a\u00a0b"', '"a\u202eb"'])
      expect(ad(`${lp}@example.com`), lp).toEqual([[{ name: null, address: null }], ['address-ambiguous']]);
    // the fixture: one From, each local part unreadable, the rest of the list kept
    const [r] = ad('a\u0000b@example.com, x\u0001@example.com, y\u007f@example.com, Z <z\u202e@example.com>, ceo\u200b@example.com, ok@example.com');
    expect(r.map((a) => a.address)).toEqual([null, null, null, null, null, 'ok@example.com']);
    // what stays: non-ASCII letters, an astral character, an ASCII space inside quotes
    expect(ad('jörg\u{1f600}@example.com')[0][0]!.address).toBe('jörg\u{1f600}@example.com');
    expect(ad('"a b"@example.com')[0][0]!.address).toBe('"a b"@example.com');
  });

  test('A-labels: every xn-- label of URL\'s output is checked, and a U-label must round-trip', () => {
    for (const a of ['a@\uff58n--example-.com', 'a@xn--example-.com', 'a@\uff58n--bcher-kva.de', 'a@bü\u00adcher.de', 'a@\uff42\u00fccher.example'])
      expect(ad(a)[0][0]!.address, a).toBe(null);
    expect(ad('a@BÜCHER.example')[0][0]!.address).toBe('a@BÜCHER.example');
    // NFC first: U+212B (ANGSTROM SIGN) is U+00C5
    expect(ad('a@\u212bngstr\u00f6m.example')[0][0]!.address).toBe('a@\u212bngstr\u00f6m.example');
    expect(ad('a@bu\u0308cher.example')[0][0]!.address).toBe('a@bu\u0308cher.example');
    expect(sameAddress('a@bu\u0308cher.example', 'a@xn--bcher-kva.example')).toBe(true);
    expect(addressKey('a@\uff58n--example-.com')).toBe(null);
  });

  test('encoded words with a dot in unquoted names and group names; glued ones stay literal', () => {
    expect(ad('=?utf-8?Q?J._M=C3=BCller?= <a@example.com>')).toEqual([[{ name: 'J. Müller', address: 'a@example.com' }], []]);
    expect(ad('"=?utf-8?Q?J._M=C3=BCller?=" <a@example.com>')[0][0]!.name).toBe('J. Müller');
    expect(ad('=?utf-8?Q?J._M=C3=BCller?=: a@example.com;')[0]).toEqual([{ name: null, address: 'a@example.com', group: 'J. Müller' }]);
    expect(ad('John Q. Public <a@b>')[0][0]!.name).toBe('John Q. Public');
    expect(ad('=?utf-8?q?a?=.=?utf-8?q?b?= <a@b>')[0][0]!.name).toBe('=?utf-8?q?a?=.=?utf-8?q?b?=');
    expect(ad('x.=?utf-8?q?a?= <a@b>')[0][0]!.name).toBe('x.=?utf-8?q?a?=');
  });

  test('quoted strings: whole words inside are decoded, a word glued inside stays literal', () => {
    expect(ad('"a =?utf-8?q?b?= c" <x@y>')[0][0]!.name).toBe('a b c');
    expect(ad('"=?utf-8?q?a?=b" <x@y>')[0][0]!.name).toBe('=?utf-8?q?a?=b');
    expect(ad('"x=?utf-8?q?a?=" <x@y>')[0][0]!.name).toBe('x=?utf-8?q?a?=');
    expect(ad('"collab=?x?b?QA==?=psres.net" <x@y>')[0][0]!.name).toBe('collab=?x?b?QA==?=psres.net');
  });

  test('filenames: trailing dots and spaces trimmed after a cut; CONIN$, CONOUT$ reserved; <>|?*" made _', () => {
    expect(safeName('a'.repeat(254) + '. ' + 'b'.repeat(40))).toBe('a'.repeat(254));
    expect(safeName('a'.repeat(250) + ' '.repeat(10) + 'b'.repeat(40))).toBe('a'.repeat(250));
    expect(safeName('con' + ' '.repeat(300) + 'x')).toBe('_con');
    for (const n of ['CONIN$', 'conout$.txt', 'CONIN$ .log']) expect(safeName(n), n).toBe('_' + n);
    expect(safeName('CONIN$x')).toBe('CONIN$x');
    expect(safeName('a<b>c|d?e*f"g.txt')).toBe('a_b_c_d_e_f_g.txt');
    const longReserved = safeName('con.' + 'x'.repeat(300));
    expect(longReserved.length).toBeLessThanOrEqual(255);
    expect(longReserved.startsWith('_con.')).toBe(true);
  });

  test('dates: after the zone only comments and whitespace', () => {
    for (const d of ['1 Jan 2026 00:00:00 GMT+0100', '1 Jan 2026 00:00:00 +0100 garbage 99', '1 Jan 2026 00:00 +0100 +0200', '1 Jan 2026 00:00 EST5EDT',
      '1 Jan 2026 00:00 CEST x', '1 Jan 2026 00:00 +0100.'])
      expect(parseDate(d), d).toBe(null);
    expect(parseDate('1 Jan 2026 00:00:00 +0100 (CET) ')).toBe('2026-01-01T00:00:00+01:00');
    expect(parseDate('1 Jan 2026 00:00:00 CEST (x)')).toBe('2026-01-01T00:00:00-00:00');
  });

  test('AVIF: compatible brands looked for in the first 4 kB only', () => {
    const box = (at: number) => { const b = new Uint8Array(at + 8); b.set([0, 0, (b.length >> 8) & 255, b.length & 255]); b.set(enc('ftypmif1'), 4); b.set(enc('avif'), at); return b; };
    expect(imageType(box(4088))).toBe('avif');
    expect(imageType(box(4096))).toBe(null);
  });

  test('header blocks: a leading BOM stays in the raw value; an mbox From line first in the root is skipped silently', () => {
    const bytes = latin('A: \xef\xbb\xbfx\r\nB: \xef\xbb\xbf\r\n\r\n');
    const [block, p] = withProblems((s) => readHeaders(bytes, 0, bytes.length, false, s));
    expect(block.fields.map((f) => f.value)).toEqual(['\ufeffx', '\ufeff']);
    expect(p).toEqual([]);
    expect(clean('\ufeffx')).toBe('x');
    const mbox = latin('From x@y Mon Nov 24 09:30:00 2026\nA: b\n\n');
    const [root, q] = withProblems((s) => readHeaders(mbox, 0, mbox.length, true, s));
    expect(root.fields.map((f) => [f.name, f.value])).toEqual([['a', 'b']]);
    expect(q).toEqual([]);
    // not the root, or not first, or `From :`: as before
    expect(withProblems((s) => readHeaders(mbox, 0, mbox.length, false, s))[1]).toEqual(['header-malformed']);
    const later = latin('A: b\nFrom x@y\n\n');
    expect(withProblems((s) => readHeaders(later, 0, later.length, true, s))[1]).toEqual(['header-malformed']);
    const field = latin('From : a@b\n\n');
    expect(withProblems((s) => readHeaders(field, 0, field.length, true, s))[0].fields.map((f) => f.name)).toEqual(['from']);
  });

  test('base64: junk after padding is not mid-stream padding; base64 after it is', () => {
    const r = (s: string) => { const [x, p] = withProblems((sink) => base64Result(latin(s), 0, s.length, sink)); return [str(x.bytes), x.midPadding, p]; };
    expect(r('QQ==!')).toEqual(['A', false, ['base64-junk']]);
    expect(r('QQ==\r\n-- \r\n')).toEqual(['A', false, ['base64-junk']]);
    expect(r('QQ==QUJD')).toEqual(['AABC', true, ['base64-junk']]);
    expect(r('QQ==!QUJD')).toEqual(['AABC', true, ['base64-junk']]);
    expect(r('QQ==\r\n')).toEqual(['A', false, []]);
  });
});

describe('purity', () => {
  test('calls do not depend on the calls before them', () => {
    const run = () => [addresses('A <a@b>, "x" <c@d>', () => {}), parameterField("a; n*1=b; n*0*=utf-8''%C3%A9", () => {}),
      decodeWords('=?utf-8?q?x?= =?x?q?y?=', () => {}), parseDate('1 Jan 2026 00:00 EST')];
    const first = JSON.stringify(run());
    addresses('('.repeat(100) + '<<<', () => {});
    decodeWords('=?utf-8?q?a?='.repeat(5000), () => {});
    expect(JSON.stringify(run())).toBe(first);
  });

  test("the modules fold: sinter's own check finds only the allowed globals", async () => {
    const check = new URL('../node_modules/@tiaforge-ui/sinter/dist/fold-check.js', import.meta.url).href;
    const { foldVerdict } = (await import(check)) as { foldVerdict: (file: string, name: string, root: string) => { fold: boolean } };
    const root = fileURLToPath(new URL('..', import.meta.url));
    const entries: [string, string[]][] = [
      ['decode', ['base64', 'quotedPrintable', 'transferDecode', 'canonicalize', 'hasBareLF']],
      ['charset', ['decodeText', 'supported']],
      ['headers', ['readHeaders', 'decodeWords', 'unstructured', 'parameterField', 'contentType', 'transferEncoding', 'messageIds', 'clean', 'hasControl']],
      ['address', ['addresses', 'sameAddress', 'addressKey', 'punycode']],
      ['date', ['parseDate']],
      ['filename', ['filename', 'safeName']],
      ['sha256', ['sha256', 'hex', 'stepDigest', 'verifyDigest']],
      ['magic', ['imageType']],
    ];
    for (const [file, names] of entries) {
      const path = fileURLToPath(new URL(`../sinter/mime/${file}.ts`, import.meta.url));
      for (const name of names) expect(foldVerdict(path, name, root), `${file}.${name}`).toEqual({ fold: true });
    }
  });
});
