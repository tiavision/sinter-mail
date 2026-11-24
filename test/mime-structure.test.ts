// The MIME reader's structure (docs/proposals/sinter-mail-mime.md, sections 1 to 4): the entity scan,
// ids, boundaries, limits, the problems of the structure layer and their blocking flags, choosing what to show,
// the message's headers and attachments, mail.mime's options and cache, mail.bytes and mail.imageType, purity.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mime } from '../sinter/mime.js';
import { bytes as refBytes, imageType } from '../sinter/bytes.js';
import * as helpers from '../sinter/sinter.helpers.js';
import { all, newBudget, scan } from '../sinter/mime/scan.js';
import { sameProtection } from '../sinter/mime/show.js';
import type { Message, Part, Ref } from '../sinter/mime/types.js';
import { latin1 } from './mime-corpus.js';

/** a message from lines, joined with CRLF */
const eml = (...lines: string[]) => lines.join('\r\n');
const HEAD = ['From: A <a@example.test>', 'To: b@example.test', 'Subject: test', 'MIME-Version: 1.0'];
const multipart = (type: string, boundary: string, ...parts: string[][]) =>
  [`Content-Type: ${type}; boundary="${boundary}"`, '', ...parts.flatMap((p) => [`--${boundary}`, ...p]), `--${boundary}--`, ''];

const codes = (m: Message) => m.problems.map((p) => p.code);
const problem = (m: Message, code: string) => m.problems.find((p) => p.code === code);
const texts = (m: Message) => m.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'html' ? p.html : p.type));
const entities = (s: string | Uint8Array) => all(scan(typeof s === 'string' ? new TextEncoder().encode(s) : s).root);
const byId = (s: string | Uint8Array, id: string) => entities(s).find((e) => e.id === id)!;

describe('ids and the tree', () => {
  test('a non-multipart root is 1 with no children', () => {
    const m = mime(eml(...HEAD, 'Content-Type: text/plain', '', 'hello'));
    expect(m.parts).toMatchObject([{ id: '1', type: 'text', text: 'hello' }]);
    expect(m.problems).toEqual([]);
  });

  test('parts are 1.1, 1.2, theirs 1.2.1; ids continue through nested messages', () => {
    const inner = ['From: c@example.test', 'Subject: inner', ...multipart('multipart/mixed', 'in', ['Content-Type: text/plain', '', 'inner one'], ['Content-Type: text/plain', '', 'inner two'])];
    const s = eml(...HEAD, ...multipart('multipart/mixed', 'out',
      ['Content-Type: text/plain', '', 'first'],
      ['Content-Type: multipart/alternative; boundary=alt', '', '--alt', 'Content-Type: text/plain', '', 'alt text', '--alt', 'Content-Type: text/html', '', '<p>alt</p>', '--alt--'],
      ['Content-Type: message/rfc822', '', ...inner],
      ['Content-Type: message/rfc822', '', 'Subject: single', '', 'single body']));
    const ids = entities(s).map((e) => `${e.id} ${e.type}`);
    expect(ids).toEqual(['1 multipart/mixed', '1.1 text/plain', '1.2 multipart/alternative', '1.2.1 text/plain', '1.2.2 text/html',
      '1.3 message/rfc822', '1.3 multipart/mixed', '1.3.1 text/plain', '1.3.2 text/plain', '1.4 message/rfc822', '1.4.1 text/plain']);
    const m = mime(s);
    expect(m.parts.map((p) => p.id)).toEqual(['1.1', '1.2.2', '1.3', '1.4']);
    const nested = m.parts[2] as Part & { type: 'message' };
    expect(nested.message.headers.subject).toBe('inner');
    expect(texts(nested.message)).toEqual(['inner one', 'inner two']);
    expect(nested.message.parts.map((p) => p.id)).toEqual(['1.3.1', '1.3.2']);
    expect((m.parts[3] as Part & { type: 'message' }).message.parts[0]!.id).toBe('1.4.1');
    // a nested message has no steps and no problems of its own
    expect(nested.message.steps).toEqual([]);
    expect(nested.message.problems).toEqual([]);
    expect(new TextDecoder().decode(refBytes(s, nested.ref))).toMatch(/^From: c@example.test\r\nSubject: inner\r\n/);
  });

  test('Refs are byte offsets into the input; the line break before a delimiter belongs to it', () => {
    const s = eml(...HEAD, ...multipart('multipart/mixed', 'b', ['Content-Type: application/octet-stream', '', 'abc', ''], ['Content-Type: text/plain', '', 'x']));
    const a = mime(s).attachments[0]!;
    expect(s.slice(a.ref.start, a.ref.end)).toBe('abc\r\n');
    expect(a.size).toBe(5);
    const e = byId(s, '1.1');
    expect(s.slice(e.start, e.end)).toBe('Content-Type: application/octet-stream\r\n\r\nabc\r\n');
  });

  test('the same bytes and options give the same message', () => {
    const s = eml(...HEAD, ...multipart('multipart/mixed', 'b', ['Content-Type: text/plain', '', 'x'], ['Content-Type: image/png', 'Content-ID: <i>', '', 'png']));
    expect(JSON.stringify(mime(new TextEncoder().encode(s)))).toBe(JSON.stringify(mime(new TextEncoder().encode(s))));
  });
});

describe('boundaries and line ends', () => {
  test('`--boundaryX` is not `--boundary`; padding after a delimiter is legal; a bare CR is no line end', () => {
    const s = eml(...HEAD, 'Content-Type: multipart/mixed; boundary=b', '', 'preamble --b', '--b \t',
      'Content-Type: text/plain', '', 'one', '--bX', '--b-', '--b\rnot', '--b\t', '', 'two', '--b-- ', 'epilogue', '--b', 'still epilogue');
    const m = mime(s);
    expect(texts(m)).toEqual(['one\r\n--bX\r\n--b-\r\n--b\rnot', 'two']);
    expect(m.problems).toEqual([]);
  });

  test('bare LF ends a line everywhere, CRLF and LF mixed', () => {
    const s = 'Content-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: text/plain\n\nlf\n--b\r\nContent-Type: text/plain\r\n\r\ncrlf\r\n--b--\n';
    expect(texts(mime(s))).toEqual(['lf', 'crlf']);
  });

  test('a close delimiter followed by text is no delimiter', () => {
    const m = mime(eml(...HEAD, 'Content-Type: multipart/mixed; boundary=b', '', '--b', '', 'x', '--b--junk'));
    expect(texts(m)).toEqual(['x\r\n--b--junk']);
    expect(problem(m, 'boundary-missing-close')).toEqual({ code: 'boundary-missing-close', part: '1', blocking: true });
  });

  test('a missing close ends the multipart at its parent\'s delimiter or at the end, blocking', () => {
    const s = eml(...HEAD, 'Content-Type: multipart/mixed; boundary=o', '', '--o', 'Content-Type: multipart/mixed; boundary=i', '', '--i', '', 'in', '--o', '', 'out');
    const m = mime(s);
    expect(texts(m)).toEqual(['in', 'out']);
    expect(m.problems).toEqual([{ code: 'boundary-missing-close', part: '1.1', blocking: true }, { code: 'boundary-missing-close', part: '1', blocking: true }]);
  });

  test('an empty body whose blank line is the delimiter\'s line break is legal', () => {
    const m = mime('Content-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: text/plain\n\n--b\nContent-Type: text/plain\n\nx\n--b--\n');
    expect(texts(m)).toEqual(['', 'x']);
    expect(m.problems).toEqual([]);
  });

  test('headers that run into the delimiter: an empty body, no-header-end (informational)', () => {
    const m = mime('Content-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: text/plain\n--b\n\nx\n--b--\n');
    expect(texts(m)).toEqual(['', 'x']);
    expect(m.problems).toEqual([{ code: 'no-header-end', part: '1.1', blocking: false }]);
  });

  test.each([
    ['missing', 'Content-Type: multipart/mixed'],
    ['empty', 'Content-Type: multipart/mixed; boundary=""'],
    ['longer than 70', `Content-Type: multipart/mixed; boundary="${'x'.repeat(71)}"`],
    ['outside bchars', 'Content-Type: multipart/mixed; boundary="a@b"'],
    ['a trailing space', 'Content-Type: multipart/mixed; boundary="ab "'],
    ['an encoded word', 'Content-Type: multipart/mixed; boundary="=?utf-8?q?ab?="'],
  ])('a boundary %s is boundary-invalid: the entity is one attachment of its bytes', (_, ct) => {
    const s = eml(...HEAD, ct, '', '--ab', '', 'x', '--ab--', '');
    const m = mime(s);
    expect(problem(m, 'boundary-invalid')).toEqual({ code: 'boundary-invalid', part: '1', blocking: true });
    expect(m.parts).toEqual([]);
    expect(m.attachments).toMatchObject([{ id: '1', contentType: 'multipart/mixed', kind: 'file', ref: { start: 0, end: s.length, encoding: 'identity' } }]);
  });

  test('exactly 70 characters is valid', () => {
    const b = "'()+_,-./:=? 09azAZ".padEnd(70, 'q');
    expect(texts(mime(eml(...HEAD, `Content-Type: multipart/mixed; boundary="${b}"`, '', `--${b}`, '', 'x', `--${b}--`)))).toEqual(['x']);
  });

  test('a child boundary starting with an ancestor\'s is boundary-invalid; one that is a prefix of it is legal', () => {
    const bad = eml(...HEAD, ...multipart('multipart/mixed', 'abc', ['Content-Type: multipart/mixed; boundary="abcd"', '', '--abcd', '', 'in', '--abcd--'], ['', 'after']));
    const m = mime(bad);
    expect(m.problems).toEqual([{ code: 'boundary-invalid', part: '1.1', blocking: true }]);
    expect(texts(m)).toEqual(['after']);
    expect(m.attachments.map((a) => a.id)).toEqual(['1.1']);
    const ok = eml(...HEAD, ...multipart('multipart/mixed', 'abcd', ['Content-Type: multipart/mixed; boundary="abc"', '', '--abc', '', 'in', '--abc--'], ['', 'after']));
    expect(texts(mime(ok))).toEqual(['in', 'after']);
    expect(mime(ok).problems).toEqual([]);
    // except when the ancestor's is the child's with `--` appended: the child's close line is the ancestor's delimiter
    const close = eml(...HEAD, ...multipart('multipart/mixed', 'abc--', ['Content-Type: multipart/mixed; boundary="abc"', '', '--abc', '', 'in', '--abc--'], ['', 'after']));
    expect(mime(close).problems).toContainEqual({ code: 'boundary-invalid', part: '1.1', blocking: true });
  });

  test('two boundary forms with different values: parameter-conflict, blocking; a filename conflict is not', () => {
    const m = mime(eml(...HEAD, "Content-Type: multipart/mixed; boundary=b; boundary*=utf-8''c", '', '--c', '', 'x', '--c--'));
    expect(texts(m)).toEqual(['x']);
    expect(problem(m, 'parameter-conflict')).toEqual({ code: 'parameter-conflict', part: '1', blocking: true });
    const f = mime(eml(...HEAD, 'Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="b.pdf"', '', 'x'));
    expect(problem(f, 'parameter-conflict')).toEqual({ code: 'parameter-conflict', part: '1', blocking: false });
    expect(f.attachments[0]!.filename).toBe('b.pdf');
  });
});

describe('the structure layer\'s problems', () => {
  test('a repeated Content-Type: the first counts, duplicate-field, blocking', () => {
    const m = mime(eml(...HEAD, 'Content-Type: text/plain', 'Content-Type: text/html', '', 'x'));
    expect(m.parts).toMatchObject([{ type: 'text', text: 'x' }]);
    expect(m.problems).toEqual([{ code: 'duplicate-field', part: '1', blocking: true }]);
  });

  test('a repeated From or Subject is duplicate-header, informational; all From addresses, the first Subject', () => {
    const m = mime(eml('From: a@x.test', 'From: b@x.test', 'Subject: one', 'Subject: two', '', 'x'));
    expect(m.headers.from.map((a) => a.address)).toEqual(['a@x.test', 'b@x.test']);
    expect(m.headers.subject).toBe('one');
    expect(m.problems).toEqual([{ code: 'duplicate-header', part: '1', blocking: false }]);
  });

  test('a transfer encoding on a multipart or a message is ignored: encoding-on-multipart, blocking', () => {
    const m = mime(eml(...HEAD, 'Content-Transfer-Encoding: base64', ...multipart('multipart/mixed', 'b', ['', 'x'])));
    expect(texts(m)).toEqual(['x']);
    expect(m.problems).toEqual([{ code: 'encoding-on-multipart', part: '1', blocking: true }]);
    const n = mime(eml(...HEAD, ...multipart('multipart/mixed', 'b', ['Content-Type: message/rfc822', 'Content-Transfer-Encoding: quoted-printable', '', 'Subject: in', '', 'body'])));
    expect(n.problems).toEqual([{ code: 'encoding-on-multipart', part: '1.1', blocking: true }]);
    expect((n.parts[0] as Part & { type: 'message' }).message.headers.subject).toBe('in');
  });

  test('an unknown transfer encoding: the part is an attachment, undecoded; encoding-unknown, blocking', () => {
    const s = eml(...HEAD, 'Content-Type: text/plain', 'Content-Transfer-Encoding: x-uuencode', '', 'begin 644 a', 'end');
    const m = mime(s);
    expect(m.parts).toEqual([]);
    expect(m.attachments).toMatchObject([{ id: '1', kind: 'file', contentType: 'text/plain', ref: { encoding: 'identity' }, size: 16 }]);
    expect(m.problems).toEqual([{ code: 'encoding-unknown', part: '1', blocking: true }]);
  });

  test('a Content-Type that does not parse is text/plain; charset=us-ascii: content-type-invalid, blocking', () => {
    const m = mime(latin1(eml('Content-Type: /', '', 'caf\xe9')));
    expect(m.parts).toMatchObject([{ type: 'text', contentType: 'text/plain', text: 'café' }]);
    expect(m.problems).toEqual([{ code: 'content-type-invalid', part: '1', blocking: true }]);
  });

  test('a header line without a colon: header-malformed, blocking', () => {
    const m = mime(eml('From: a@x.test', 'no colon here', 'Content-Type: text/plain', '', 'x'));
    expect(texts(m)).toEqual(['x']);
    expect(m.problems).toEqual([{ code: 'header-malformed', part: '1', blocking: true }]);
  });

  test('a control byte in a structural field or a field name: control-in-structure, blocking', () => {
    const m = mime(latin1(eml(...HEAD, ...multipart('multipart/mixed', 'b', ['Content-Type: text/plain; charset=utf-8\x00x', '', 'x']))));
    expect(problem(m, 'control-in-structure')).toEqual({ code: 'control-in-structure', part: '1.1', blocking: true });
    const n = mime(latin1(eml('X-A\x01b: c', 'Content-Type: text/plain', '', 'x')));
    expect(problem(n, 'control-in-structure')).toMatchObject({ part: '1', blocking: true });
  });

  test('a repeated boundary parameter: the first counts, duplicate-parameter, blocking', () => {
    const m = mime(eml(...HEAD, 'Content-Type: multipart/mixed; boundary=a; boundary=b', '', '--a', '', 'x', '--b', '', 'y', '--a--'));
    expect(texts(m)).toEqual(['x\r\n--b\r\n\r\ny']);
    expect(m.problems).toEqual([{ code: 'duplicate-parameter', part: '1', blocking: true }]);
  });

  test('each entity records its blocking problems, and whether one is in or above it, in or below it', () => {
    const s = eml(...HEAD, ...multipart('multipart/mixed', 'o',
      ['Content-Type: multipart/mixed; boundary=i', '', '--i', 'Content-Type: text/plain', 'Content-Type: text/html', '', 'dup', '--i', '', 'ok', '--i--'],
      ['', 'sibling']));
    const e = (id: string) => byId(s, id);
    expect(e('1.1.1').blocking).toEqual(['duplicate-field']);
    expect([e('1').above, e('1').below]).toEqual([false, true]);
    expect([e('1.1').above, e('1.1').below]).toEqual([false, true]);
    expect([e('1.1.1').above, e('1.1.1').below]).toEqual([true, true]);
    expect([e('1.1.2').above, e('1.1.2').below]).toEqual([false, false]);
    expect([e('1.2').above, e('1.2').below]).toEqual([false, false]);
    const t = eml(...HEAD, 'Content-Type: multipart/mixed; boundary=b; boundary=c', '', '--b', '', 'x', '--b--');
    expect(byId(t, '1.1').above).toBe(true);
  });

  test('informational problems never block', () => {
    const m = mime(latin1(eml(...HEAD, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', '6Q==!')));
    expect(m.problems.every((p) => !p.blocking)).toBe(true);
    expect(codes(m).sort()).toEqual(['base64-junk', 'charset-fallback']);
    expect(texts(m)).toEqual(['é']);
  });
});

describe('limits', () => {
  const nest = (depth: number) => {
    const b = (i: number) => `n${String(i).padStart(3, '0')}`;
    const lines = [`Content-Type: multipart/mixed; boundary=${b(0)}`, ''];
    for (let i = 1; i < depth; i++) lines.push(`--${b(i - 1)}`, `Content-Type: multipart/mixed; boundary=${b(i)}`, '');
    lines.push(`--${b(depth - 1)}`, '', 'deep');
    for (let i = depth - 1; i >= 0; i--) lines.push(`--${b(i)}--`);
    return eml(...lines);
  };

  test('32 levels are read; the 33rd is one attachment of its bytes with a limit problem', () => {
    expect(texts(mime(nest(31)))).toEqual(['deep']);
    expect(mime(nest(31)).problems).toEqual([]);
    const m = mime(nest(33));
    expect(m.parts).toEqual([]);
    expect(m.problems).toEqual([{ code: 'limit', part: Array(33).fill('1').join('.'), blocking: true }]);
    expect(m.attachments).toMatchObject([{ contentType: 'multipart/mixed', kind: 'file' }]);
  });

  test('1,000 entities; the rest of a multipart past them is one attachment', () => {
    const parts = Array.from({ length: 1200 }, (_, i) => ['', `p${i + 1}`]);
    const m = mime(eml(...HEAD, ...multipart('multipart/mixed', 'b', ...parts)));
    expect(m.parts.length).toBe(999);
    expect(m.attachments).toMatchObject([{ id: '1.1000', kind: 'file' }]);
    expect(m.problems).toEqual([{ code: 'limit', part: '1.1000', blocking: true }]);
  });

  test('8 levels of nested messages; the 9th is an attachment of kind message', () => {
    let s = 'Subject: 9\r\n\r\ninnermost';
    for (let i = 8; i >= 0; i--) s = `Subject: ${i}\r\nContent-Type: message/rfc822\r\n\r\n${s}`;
    const m = mime(s);
    let msg = m, depth = 0;
    while (msg.parts[0]?.type === 'message') { msg = msg.parts[0].message; depth++; }
    expect(depth).toBe(8);
    expect(msg.attachments).toMatchObject([{ kind: 'message', contentType: 'message/rfc822' }]);
    expect(m.problems).toMatchObject([{ code: 'limit', blocking: true }]);
  });

  test('one budget per call: the byte budget cuts the source, a limit problem with part null', () => {
    const src = new TextEncoder().encode(eml('Content-Type: text/plain', '', 'x'.repeat(100)));
    const budget = { ...newBudget(), bytes: 50 };
    const s = scan(src, {}, budget);
    expect(s.end).toBe(50);
    expect(budget.overrun).toBe(true);
    expect(s.problems).toMatchObject([{ entity: null, code: 'limit', blocking: true }]);
    // a second source in the same call starts with what is left
    const t = scan(src, { source: 'step', prefix: 'step/' }, budget);
    expect(t.end).toBe(0);
    expect(t.root.id).toBe('step/1');
  });

  test('the part budget is shared by the sources of one call', () => {
    const src = new TextEncoder().encode(eml(...multipart('multipart/mixed', 'b', ['', 'a'], ['', 'b'])));
    const budget = { ...newBudget(), parts: 4 };
    scan(src, {}, budget);
    expect(budget.parts).toBe(1);
    const second = scan(src, { source: 's', prefix: 's/' }, budget);
    expect(all(second.root).map((e) => `${e.id} ${e.opaque}`)).toEqual(['s/1 null', 's/1.1 limit']);
  });

  test('a payload scanned as a second source continues its parent\'s depth, nesting and blocking', () => {
    const outer = scan(new TextEncoder().encode('Content-Type: text/plain\r\nContent-Type: text/html\r\n\r\nx'));
    const payload = scan(new TextEncoder().encode(eml(...multipart('multipart/mixed', 'b', ['', 'a']))), { source: '1#ab', prefix: '1#ab/', parent: outer.root });
    expect(all(payload.root).map((e) => [e.id, e.depth, e.source, e.above])).toEqual([['1#ab/1', 2, '1#ab', true], ['1#ab/1.1', 3, '1#ab', true]]);
    expect(payload.root.parent).toBe(outer.root);
  });
});

describe('choosing what to show', () => {
  const alt = (...parts: string[][]) => eml(...HEAD, ...multipart('multipart/alternative', 'a', ...parts));
  const plain = ['Content-Type: text/plain', '', 'plain'];
  const html = ['Content-Type: text/html', '', '<p>html</p>'];

  test('multipart/alternative: the last HTML by default, the last text with prefer text', () => {
    expect(texts(mime(alt(plain, html)))).toEqual(['<p>html</p>']);
    expect(texts(mime(alt(plain, html), { prefer: 'text' }))).toEqual(['plain']);
    expect(texts(mime(alt(html, plain)))).toEqual(['<p>html</p>']);
    expect(texts(mime(alt(plain, ['Content-Type: text/plain', '', 'plain 2'])))).toEqual(['plain 2']);
    // nothing of the preferred kind: the last part that can be shown
    expect(texts(mime(alt(plain), { prefer: 'html' }))).toEqual(['plain']);
    expect(texts(mime(alt(html), { prefer: 'text' }))).toEqual(['<p>html</p>']);
  });

  test('a text candidate wholly one armored message or one cleartext-signed block wins whatever prefer says', () => {
    const armor = ['Content-Type: text/plain', '', '', '-----BEGIN PGP MESSAGE-----', '', 'hQEMA', '-----END PGP MESSAGE-----', ''];
    // chosen, and as the root's only part shown, a decrypt step
    expect(mime(alt(armor, html)).parts).toMatchObject([{ id: '1.1', type: 'encrypted', reason: 'pending' }]);
    const signed = ['Content-Type: text/plain', '', '-----BEGIN PGP SIGNED MESSAGE-----', 'Hash: SHA256', '', 'hi', '-----BEGIN PGP SIGNATURE-----', '', 'iQ', '-----END PGP SIGNATURE-----'];
    expect(mime(alt(signed, html)).parts).toMatchObject([{ id: '1.1:1', type: 'text', text: 'hi', protection: { signed: 'pending' } }]);
    // with text around it, or two blocks, it is an ordinary candidate
    const around = ['Content-Type: text/plain', '', 'see:', '-----BEGIN PGP MESSAGE-----', 'x', '-----END PGP MESSAGE-----'];
    expect(texts(mime(alt(around, html)))).toEqual(['<p>html</p>']);
    const two = ['Content-Type: text/plain', '', '-----BEGIN PGP MESSAGE-----', 'x', '-----END PGP MESSAGE-----', '-----BEGIN PGP MESSAGE-----', 'y', '-----END PGP MESSAGE-----'];
    expect(texts(mime(alt(two, html)))).toEqual(['<p>html</p>']);
  });

  test('the parts not chosen: their text and HTML are dropped, their other parts are attachments, calendar is calendar', () => {
    const s = alt(plain, ['Content-Type: text/calendar; method=REQUEST', '', 'BEGIN:VCALENDAR'],
      ['Content-Type: multipart/mixed; boundary=m', '', '--m', ...html, '--m', 'Content-Type: image/png', 'Content-Disposition: attachment; filename=a.png', '', 'png', '--m--']);
    const m = mime(s, { prefer: 'text' });
    expect(texts(m)).toEqual(['plain']);
    expect(m.attachments.map((a) => [a.id, a.kind])).toEqual([['1.2', 'calendar'], ['1.3.2', 'file']]);
    expect(m.calendar).toEqual([{ part: '1.2', method: 'REQUEST', text: 'BEGIN:VCALENDAR', attachment: '1.2' }]);
    // with HTML preferred, the HTML branch shows: the image is still an attachment
    const h = mime(s);
    expect(texts(h)).toEqual(['<p>html</p>']);
    expect(h.attachments.map((a) => a.id)).toEqual(['1.2', '1.3.2']);
  });

  test('an alternative nested in an unchosen one shows nothing', () => {
    const inner = ['Content-Type: multipart/alternative; boundary=i', '', '--i', ...plain, '--i', ...html, '--i--'];
    const s = alt(inner, ['Content-Type: text/plain', '', 'outer last']);
    // the inner alternative shows HTML, so it wins with prefer html
    expect(texts(mime(s))).toEqual(['<p>html</p>']);
    const m = mime(s, { prefer: 'text' });
    expect(texts(m)).toEqual(['outer last']);
    expect(m.attachments).toEqual([]);
  });

  test('multipart/related: the root by start, else the first; every other part a related attachment', () => {
    const rel = (start: string | null, ...parts: string[][]) => eml(...HEAD,
      ...multipart(`multipart/related${start ? `; start="${start}"` : ''}; type="text/html"`, 'r', ...parts));
    const img = (cid: string) => ['Content-Type: image/png', `Content-ID: <${cid}>`, '', 'png'];
    const m = mime(rel(null, html, img('a@x'), img('b@x')));
    expect(texts(m)).toEqual(['<p>html</p>']);
    expect(m.attachments.map((a) => [a.id, a.kind, a.contentId, a.disposition])).toEqual([['1.2', 'related', 'a@x', null], ['1.3', 'related', 'b@x', null]]);
    expect((m.parts[0] as Part & { type: 'html' }).inline).toEqual([{ contentId: 'a@x', attachment: '1.2' }, { contentId: 'b@x', attachment: '1.3' }]);
    const started = mime(rel('<root@x>', img('a@x'), ['Content-Type: text/html', 'Content-ID: <root@x>', '', '<p>root</p>']));
    expect(texts(started)).toEqual(['<p>root</p>']);
    expect(started.attachments.map((a) => [a.id, a.kind])).toEqual([['1.1', 'related']]);
  });

  test('inline sets: own related parts, then unique Content-IDs elsewhere in the message; duplicates resolve to nothing', () => {
    const s = eml(...HEAD, ...multipart('multipart/mixed', 'm',
      ['Content-Type: multipart/related; boundary=r', '', '--r', ...html, '--r', 'Content-Type: image/png', 'Content-ID: <own>', '', 'a',
        '--r', 'Content-Type: image/png', 'Content-ID: <twice>', '', 'b', '--r', 'Content-Type: image/png', 'Content-ID: <twice>', '', 'c', '--r--'],
      ['Content-Type: image/gif', 'Content-ID: <elsewhere>', 'Content-Disposition: attachment; filename=e.gif', '', 'gif'],
      ['Content-Type: image/gif', 'Content-ID: <own>', 'Content-Disposition: attachment; filename=o.gif', '', 'gif'],
      ['Content-Type: message/rfc822', '', 'Content-Type: image/png', 'Content-ID: <nested>', '', 'n']));
    const m = mime(s);
    const h = m.parts[0] as Part & { type: 'html' };
    expect(h.inline).toEqual([{ contentId: 'own', attachment: '1.1.2' }, { contentId: 'elsewhere', attachment: '1.2' }]);
    expect(m.problems.filter((p) => p.code === 'content-id-duplicate')).toEqual([
      { code: 'content-id-duplicate', part: '1.1.4', blocking: false }, { code: 'content-id-duplicate', part: '1.3', blocking: false }]);
  });

  test('inline sets keep only parts of the body\'s protection', () => {
    expect(sameProtection({ encrypted: false, signed: null }, { encrypted: false, signed: null })).toBe(true);
    expect(sameProtection({ encrypted: false, signed: 'good', step: 's' }, { encrypted: false, signed: null })).toBe(false);
    expect(sameProtection({ encrypted: true, signed: null }, { encrypted: true, signed: null, opened: true })).toBe(false);
  });

  test('multipart/mixed: text and HTML shown unless an attachment or named; the rest attachments', () => {
    const m = mime(eml(...HEAD, ...multipart('multipart/mixed', 'b', plain,
      ['Content-Type: text/plain', 'Content-Disposition: attachment', '', 'attached'],
      ['Content-Type: text/plain; name="notes.txt"', '', 'named'],
      ['Content-Type: text/html', 'Content-Disposition: inline', '', '<p>second</p>'],
      ['Content-Type: text/enriched', '', '<bold>x</bold>'],
      ['Content-Type: application/x-unknown', 'X-Mozilla-External-Attachment-URL: https://evil.example/', '', 'blob'])));
    expect(texts(m)).toEqual(['plain', '<p>second</p>']);
    expect(m.attachments.map((a) => [a.id, a.filename, a.kind])).toEqual([['1.2', 'attachment', 'file'], ['1.3', 'notes.txt', 'file'], ['1.5', 'attachment', 'file'], ['1.6', 'attachment', 'file']]);
  });

  test('unknown multipart/* reads as mixed; multipart/digest parts default to message/rfc822', () => {
    expect(texts(mime(eml(...HEAD, ...multipart('multipart/parallel', 'p', plain, html))))).toEqual(['plain', '<p>html</p>']);
    const d = mime(eml(...HEAD, ...multipart('multipart/digest', 'd', ['', 'Subject: one', '', 'first'], ['', 'Subject: two', '', 'second'])));
    expect(d.parts.map((p) => [p.type, p.contentType])).toEqual([['message', 'message/rfc822'], ['message', 'message/rfc822']]);
    expect(d.parts.map((p) => (p as Part & { type: 'message' }).message.headers.subject)).toEqual(['one', 'two']);
  });

  test('multipart/report: the human part, report parts, the returned message inline', () => {
    const m = mime(eml(...HEAD, ...multipart('multipart/report; report-type=delivery-status', 'r', ['Content-Type: text/plain', '', 'could not deliver'],
      ['Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; mx.example'],
      ['Content-Type: message/rfc822', 'Content-Disposition: attachment', '', 'Subject: original', '', 'hello'],
      ['Content-Type: text/rfc822-headers', '', 'Subject: original'])));
    expect(m.parts.map((p) => p.type)).toEqual(['text', 'report', 'message', 'report']);
    expect((m.parts[1] as Part & { type: 'report' }).text).toBe('Reporting-MTA: dns; mx.example');
    expect(m.attachments).toEqual([]);
  });

  test('message/rfc822 as an attachment is an attachment of kind message, which mail.mime reads again', () => {
    const s = eml(...HEAD, ...multipart('multipart/mixed', 'b', plain, ['Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="fwd.eml"', '', 'Subject: x', '', 'y']));
    const m = mime(s);
    expect(m.attachments).toMatchObject([{ id: '1.2', kind: 'message', filename: 'fwd.eml', contentType: 'message/rfc822' }]);
    expect(mime(refBytes(s, m.attachments[0]!.ref)).headers.subject).toBe('x');
  });

  test('message/global is a nested message', () => {
    const m = mime(eml(...HEAD, ...multipart('multipart/mixed', 'b', ['Content-Type: message/global', '', 'Subject: =?utf-8?q?gr=C3=BC=C3=9F?=', '', 'x'])));
    expect((m.parts[0] as Part & { type: 'message' }).message.headers.subject).toBe('grüß');
  });

  test('calendar, pgp-keys, encrypted files and opaque types', () => {
    const m = mime(eml(...HEAD, ...multipart('multipart/mixed', 'b', plain,
      ['Content-Type: text/calendar; charset=utf-8; method=CANCEL', '', 'BEGIN:VCALENDAR', 'DESCRIPTION:<b>x</b>'],
      ['Content-Type: application/pgp-keys', '', '-----BEGIN PGP PUBLIC KEY BLOCK-----'],
      ['Content-Type: application/octet-stream; name="doc.pdf.gpg"', '', 'x'],
      ['Content-Type: message/partial; id="a"; number=1', '', 'part'],
      ['Content-Type: message/external-body; access-type=URL; URL="https://evil.example/"', '', ''],
      ['Content-Type: application/ms-tnef; name="winmail.dat"', '', 'tnef'])));
    expect(texts(m)).toEqual(['plain']);
    expect(m.attachments.map((a) => [a.id, a.kind])).toEqual([['1.2', 'calendar'], ['1.3', 'pgp-keys'], ['1.4', 'encrypted'], ['1.5', 'file'], ['1.6', 'file'], ['1.7', 'file']]);
    expect(m.calendar).toEqual([{ part: '1.2', method: 'CANCEL', text: 'BEGIN:VCALENDAR\r\nDESCRIPTION:<b>x</b>', attachment: '1.2' }]);
  });

  test('multipart/encrypted and Exchange\'s rewrite at the root: one encrypted part, pending its decrypt step', () => {
    const enc = eml(...HEAD, ...multipart('multipart/encrypted; protocol="application/pgp-encrypted"', 'e',
      ['Content-Type: application/pgp-encrypted', '', 'Version: 1'], ['Content-Type: application/octet-stream', '', '-----BEGIN PGP MESSAGE-----']));
    const m = mime(enc);
    expect(m.attachments).toEqual([]);
    expect(m.parts).toMatchObject([{ id: '1', type: 'encrypted', reason: 'pending', contentType: 'multipart/encrypted', ref: { start: 0, end: enc.length, encoding: 'identity' } }]);
    expect(m.steps).toMatchObject([{ kind: 'decrypt', part: '1', state: 'pending', armored: true }]);
    const ex = eml(...HEAD, ...multipart('multipart/mixed', 'x', ['Content-Type: text/plain', '', ' '],
      ['Content-Type: application/pgp-encrypted', 'Content-Transfer-Encoding: base64', '', 'VmVyc2lvbjogMQ0K'], ['Content-Type: application/octet-stream', '', 'armor']));
    const n = mime(ex);
    expect(n.parts).toMatchObject([{ id: '1', type: 'encrypted', reason: 'pending' }]);
    expect(n.problems).toEqual([{ code: 'exchange-shape', part: '1', blocking: false }]);
  });

  test('multipart/signed (PGP/MIME) shows its first part, pending its verify step; the signature is not an attachment', () => {
    const m = mime(eml(...HEAD, ...multipart('multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha256', 's',
      plain, ['Content-Type: application/pgp-signature', '', '-----BEGIN PGP SIGNATURE-----'])));
    expect(texts(m)).toEqual(['plain']);
    expect(m.parts[0]!.protection).toEqual({ encrypted: false, signed: 'pending', step: m.steps[0]!.id });
    expect(m.attachments).toEqual([]);
  });

  test('text parts: charset, format=flowed and delsp', () => {
    const m = mime(latin1(eml(...HEAD, ...multipart('multipart/mixed', 'b',
      ['Content-Type: text/plain; charset=iso-8859-1; format=flowed; delsp=yes', '', 'caf\xe9 '],
      ['Content-Type: text/plain; charset=koi8-r; format=fixed', 'Content-Transfer-Encoding: quoted-printable', '', '=F0=D2=C9=D7=C5=D4'],
      ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', btoa('<p>\xc3\xa9</p>')]))));
    expect(m.parts).toMatchObject([
      { type: 'text', text: 'café ', flowed: true, delsp: true },
      { type: 'text', text: 'Привет', flowed: false, delsp: false },
      { type: 'html', html: '<p>é</p>', legacyDisplay: false, inline: [] }]);
  });
});

describe('headers and attachments', () => {
  test('outer Headers: raw unfolded and cleaned, list, autocrypt, reply, sources, summary', () => {
    const m = mime(latin1(eml('From: A <a@x.test>', 'Reply-To: r@x.test', 'Subject: =?utf-8?q?h=C3=A9?=', '  folded', 'List-Id: <l.x.test>',
      'Autocrypt: addr=a@x.test; keydata=AAAA', ' BBBB', 'X-Ctl: a\x01b', 'Date: Tue, 24 Nov 2026 09:30:00 +0100', 'Message-ID: <m@x.test>',
      'In-Reply-To: <p@x.test>', 'References: <o@x.test> <p@x.test>', 'To: t@x.test', 'Cc: c@x.test', '', 'x')));
    expect(m.headers).toBe(m.outer);
    expect(m.headers).toMatchObject({ subject: 'hé  folded', date: '2026-11-24T09:30:00+01:00', messageId: 'm@x.test', inReplyTo: ['p@x.test'],
      references: ['o@x.test', 'p@x.test'], list: [['List-Id', '<l.x.test>']], autocrypt: ['addr=a@x.test; keydata=AAAA BBBB'] });
    expect(m.headers.raw).toContainEqual(['subject', '=?utf-8?q?h=C3=A9?=  folded']);
    expect(m.headers.raw).toContainEqual(['x-ctl', 'ab']);
    expect(m.reply.map((a) => a.address)).toEqual(['r@x.test']);
    expect(mime(eml('From: a@x.test', '', 'x')).reply.map((a) => a.address)).toEqual(['a@x.test']);
    expect(Object.values(m.sources).every((s) => s === 'outer')).toBe(true);
    expect(Object.keys(m.sources).sort()).toEqual(['cc', 'date', 'from', 'inReplyTo', 'messageId', 'references', 'replyTo', 'sender', 'subject', 'to']);
    expect([m.confidential, m.steps, m.summary]).toEqual([[], [], { encrypted: 'none', signed: 'none', from: null }]);
  });

  test('attachments: safe filenames, originalFilename, content id, decoded size, the Ref', () => {
    const s = eml(...HEAD, ...multipart('multipart/mixed', 'b', ['', 'body'],
      ['Content-Type: application/octet-stream', "Content-Disposition: attachment; filename*=utf-8''..%2Fevil%E2%80%AEfdp.exe", 'Content-ID: <x@y>',
        'Content-Transfer-Encoding: base64', '', 'AAECAw=='],
      ['Content-Type: application/octet-stream; name="CON.txt"', 'Content-Disposition: weird', '', 'q']));
    const m = mime(s);
    expect(m.attachments).toEqual([
      { id: '1.2', filename: 'evilfdp.exe', originalFilename: '../evilfdp.exe', contentType: 'application/octet-stream', disposition: 'attachment',
        kind: 'file', contentId: 'x@y', size: 4, ref: m.attachments[0]!.ref, protection: { encrypted: false, signed: null } },
      expect.objectContaining({ id: '1.3', filename: '_CON.txt', disposition: 'attachment', size: 1 })]);
    expect([...refBytes(s, m.attachments[0]!.ref)]).toEqual([0, 1, 2, 3]);
  });
});

describe('mail.mime', () => {
  const S = eml(...HEAD, 'Content-Type: text/plain', '', 'x');

  test.each([
    [{ prefer: 'markdown' }, /`prefer` is 'html' or 'text'/],
    [{ decrypted: [] }, /`decrypted` is an object/],
    [{ decrypted: { a: { status: 'great', integrity: true } } }, /`decrypted\["a"\]`: `status` is/],
    [{ decrypted: { a: { status: 'ok' } } }, /`integrity` is true or false/],
    [{ decrypted: { a: { status: 'ok', integrity: true, plaintext: 'text' } } }, /`plaintext` is a Uint8Array/],
    [{ decrypted: { a: { status: 'ok', integrity: true, signatures: [{ status: 'meh' }] } } }, /signatures\[0\]: `status` is/],
    [{ verdicts: { a: { status: 'good' } } }, /`verdicts\["a"\]` is an array/],
    [{ verdicts: { a: [{ status: 'fine' }] } }, /`verdicts\["a"\]`\[0\]: `status`/],
    [{ verdicts: { a: [{ status: 'good', signer: 'a@b' }] } }, /`signer` is an array of strings/],
    [{ open: 'id' }, /`open` is an array of step ids/],
    [{ open: [1] }, /`open` is an array/],
    ['options', /the options are an object/],
  ])('invalid options throw a TypeError naming them: %j', (o, msg) => {
    expect(() => mime(S, o as never)).toThrow(TypeError);
    expect(() => mime(S, o as never)).toThrow(msg);
    expect(() => mime(S, o as never)).toThrow(/^mail\.mime: /);
  });

  test('an input that is neither bytes nor a string throws', () => {
    expect(() => mime(null as never)).toThrow(/^mail\.mime: the message is a Uint8Array or a string, not null/);
    expect(() => mime([1, 2] as never)).toThrow(TypeError);
  });

  test('a status of failed needs no integrity; results for no step are stale-result, informational', () => {
    const m = mime(S, { decrypted: { '1#00': { status: 'failed' } as never }, verdicts: { '1#01': [{ status: 'good' }] }, open: ['1#02'] });
    expect(m.problems).toEqual([{ code: 'stale-result', part: null, blocking: false }]);
  });

  test('the cache: input by identity, prefer by value, results entry by entry', () => {
    const input = new TextEncoder().encode(eml(...HEAD, ...multipart('multipart/alternative', 'a', ['', 'p'], ['Content-Type: text/html', '', 'h'])));
    const a = mime(input);
    expect(mime(input)).toBe(a);
    expect(mime(input, {})).toBe(a);
    expect(mime(input, { prefer: 'html' })).toBe(a);
    const t = mime(input, { prefer: 'text' });
    expect(t).not.toBe(a);
    expect(texts(t)).toEqual(['p']);
    expect(mime(input)).toBe(a);   // behind the last-call cache, by input and options
    // a copy of the bytes is another input
    expect(mime(input.slice())).not.toBe(a);
    expect(mime(input.slice())).toEqual(a);
    const r = { status: 'failed' as const, integrity: false };
    const d1 = mime(input, { decrypted: { x: r } });
    expect(mime(input, { decrypted: { x: r } })).toBe(d1);
    expect(mime(input, { decrypted: { x: { ...r } } })).not.toBe(d1);
    expect(mime(input, { decrypted: { y: r } })).not.toBe(d1);
    const v = [{ status: 'good' as const }];
    const v1 = mime(input, { verdicts: { s: v } });
    expect(mime(input, { verdicts: { s: v } })).toBe(v1);
    expect(mime(input, { verdicts: { s: [...v] } })).not.toBe(v1);
    const o1 = mime(input, { open: ['a'] });
    expect(mime(input, { open: ['a'] })).toBe(o1);
    expect(mime(input, { open: ['b'] })).not.toBe(o1);
  });

  test('a string is read as UTF-8; the message is deep-frozen and JSON-shaped', () => {
    const m = mime(eml(...HEAD, 'Content-Type: text/plain; charset=utf-8', '', 'grüß ✓'));
    expect(texts(m)).toEqual(['grüß ✓']);
    expect(mime(new TextEncoder().encode(eml(...HEAD, 'Content-Type: text/plain; charset=utf-8', '', 'grüß ✓')))).toEqual(m);
    const stack: unknown[] = [m];
    while (stack.length) {
      const x = stack.pop();
      if (typeof x === 'object' && x !== null) { expect(Object.isFrozen(x)).toBe(true); stack.push(...Object.values(x)); }
    }
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    expect(structuredClone(m)).toEqual(m);
  });

  test('the helpers module exports mail.mime, mail.bytes and mail.imageType', () => {
    expect(helpers.mime).toBe(mime);
    expect(helpers.bytes).toBe(refBytes);
    expect(helpers.imageType).toBe(imageType);
  });
});

describe('mail.bytes and mail.imageType', () => {
  const ref = (r: Partial<Ref>): Ref => ({ source: 'input', start: 0, end: 0, encoding: 'identity', ...r });
  const s = (u: Uint8Array) => new TextDecoder().decode(u);

  test('identity, base64, quoted-printable, from the message\'s own Refs', () => {
    const msg = eml(...HEAD, ...multipart('multipart/mixed', 'b',
      ['Content-Type: application/octet-stream', '', 'raw bytes'],
      ['Content-Type: application/octet-stream', 'Content-Transfer-Encoding: base64', '', btoa('base64 bytes')],
      ['Content-Type: application/octet-stream', 'Content-Transfer-Encoding: quoted-printable', '', 'q=3Dp soft=', 'break']));
    const atts = mime(msg).attachments;
    expect(atts.map((a) => a.ref.encoding)).toEqual(['identity', 'base64', 'quoted-printable']);
    expect(atts.map((a) => s(refBytes(msg, a.ref)))).toEqual(['raw bytes', 'base64 bytes', 'q=p softbreak']);
    expect(atts.map((a) => a.size)).toEqual([9, 12, 13]);
    expect(s(refBytes(new TextEncoder().encode(msg), atts[1]!.ref))).toBe('base64 bytes');
  });

  test('canonical converts bare LF to CRLF after decoding; slice applies to the decoded bytes', () => {
    const input = 'a\nb\r\nc\rd';
    expect(s(refBytes(input, ref({ end: input.length, canonical: true })))).toBe('a\r\nb\r\nc\rd');
    const b64 = btoa('hello world');
    expect(s(refBytes(b64, ref({ end: b64.length, encoding: 'base64', slice: [6, 11] })))).toBe('world');
    expect(s(refBytes('x\ny', ref({ end: 3, slice: [1, 3], canonical: true })))).toBe('\r\ny');
  });

  test('a new array each call, a string input as UTF-8', () => {
    const r = ref({ end: 2 });
    const a = refBytes('é', r);
    expect([...a]).toEqual([0xc3, 0xa9]);
    expect(refBytes('é', r)).not.toBe(a);
  });

  test('a decrypted step\'s plaintext is a source; one without an ok plaintext throws', () => {
    const plaintext = new TextEncoder().encode('inner text');
    const decrypted = { '1#ab': { status: 'ok' as const, integrity: true, plaintext } };
    expect(s(refBytes('outer', ref({ source: '1#ab', start: 6, end: 10 }), { decrypted }))).toBe('text');
    expect(() => refBytes('outer', ref({ source: '1#ab', end: 1 }))).toThrow(/^mail\.bytes: step "1#ab" has no 'ok' plaintext/);
    expect(() => refBytes('outer', ref({ source: '1#ab', end: 1 }), { decrypted: { '1#ab': { status: 'failed', integrity: false } } })).toThrow(TypeError);
    expect(() => refBytes('outer', ref({ source: '__proto__', end: 1 }), { decrypted: {} })).toThrow(TypeError);
  });

  test.each([
    [ref({ end: 99 }), /past its source's 5 bytes/],
    [ref({ start: 3, end: 2 }), /start <= end/],
    [ref({ start: -1, end: 2 }), /offsets/],
    [ref({ start: 0.5, end: 2 }), /offsets/],
    [ref({ end: 2, encoding: 'uuencode' as never }), /`ref.encoding`/],
    [ref({ end: 2, slice: [0, 9] }), /`ref.slice`/],
    [ref({ end: 2, slice: [2, 1] }), /`ref.slice`/],
    [ref({ end: 2, canonical: false as never }), /`ref.canonical`/],
    [null as never, /the ref is a Ref/],
  ])('a Ref outside its source throws a TypeError: %j', (r, msg) => {
    expect(() => refBytes('hello', r)).toThrow(TypeError);
    expect(() => refBytes('hello', r)).toThrow(msg);
  });

  test('mail.imageType by magic number, never SVG', () => {
    expect(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(imageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(null);
    expect(() => imageType('png' as never)).toThrow(/^mail\.imageType: /);
  });
});

describe('purity and laziness', () => {
  test("mail.mime, mail.bytes and mail.imageType fold: sinter's own check finds only the allowed globals", async () => {
    const check = new URL('../node_modules/@tiaforge-ui/sinter/dist/fold-check.js', import.meta.url).href;
    const { foldVerdict } = (await import(check)) as { foldVerdict: (file: string, name: string, root: string) => { fold: boolean } };
    const root = fileURLToPath(new URL('..', import.meta.url));
    const at = (f: string) => fileURLToPath(new URL(`../sinter/${f}`, import.meta.url));
    expect(foldVerdict(at('mime.ts'), 'mime', root)).toEqual({ fold: true });
    expect(foldVerdict(at('bytes.ts'), 'bytes', root)).toEqual({ fold: true });
    expect(foldVerdict(at('bytes.ts'), 'imageType', root)).toEqual({ fold: true });
    for (const [f, n] of [['mime/index.ts', 'read'], ['mime/scan.ts', 'scan'], ['mime/show.ts', 'message'], ['mime/crypto.ts', 'cryptoShape'], ['sinter.helpers.ts', 'mime']]) {
      expect(foldVerdict(at(f), n, root), `${f} ${n}`).toEqual({ fold: true });
    }
  });

  const imports = (f: string) => [...readFileSync(new URL(`../sinter/${f}`, import.meta.url), 'utf8')
    .matchAll(/^\s*(import|export)\b([^'"]*?)from\s+'([^']+)'/gm)].map((m) => ({ type: /^\s*type\b/.test(m[2]!) || m[1] === 'import' && /^\s+type\s/.test(m[2]!), from: m[3]! }));

  test('mime.ts imports the reader only by its specifier; its cache imports no reader', () => {
    const values = imports('mime.ts').filter((i) => !i.type).map((i) => i.from);
    expect(values).toEqual(['@tiavision/sinter-mail/mime', './mime/cache.js']);
    expect(imports('mime/cache.ts').filter((i) => !i.type)).toEqual([]);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.exports['./mime']).toBe('./sinter/mime/index.ts');
  });

  test('`./mime` exports `read` and `cutMessage` only (and types); the package exports neither the reader\'s internals nor the cache', async () => {
    expect(Object.keys(await import('../sinter/mime/index.js')).sort()).toEqual(['cutMessage', 'read']);
    const pkg = await import('../sinter/index.js');
    expect(Object.keys(pkg).sort()).toEqual(['bytes', 'cut', 'forget', 'imageType', 'links', 'mime', 'parse', 'plain', 'progressive', 'text', 'unquoted']);
    expect(Object.keys(pkg.mime)).toEqual(['clear']);
  });

  test('bytes.ts imports no reader: the decoders and the magic numbers only', () => {
    expect(imports('bytes.ts').filter((i) => !i.type).map((i) => i.from).sort()).toEqual(['./mime/decode.js', './mime/magic.js']);
    for (const f of ['mime/decode.ts', 'mime/magic.ts']) expect(imports(f).filter((i) => !i.type)).toEqual([]);
  });

  test('calls do not depend on the calls before them', () => {
    const s = eml(...HEAD, ...multipart('multipart/related', 'r', ['Content-Type: text/html', '', 'h'], ['Content-Type: image/png', 'Content-ID: <a>', '', 'p']));
    const first = JSON.stringify(mime(new TextEncoder().encode(s)));
    mime(eml(...HEAD, 'Content-Type: multipart/mixed; boundary=b', '', '--b', '', 'x'));
    mime(new TextEncoder().encode(s), { prefer: 'text' });
    expect(JSON.stringify(mime(new TextEncoder().encode(s)))).toBe(first);
  });
});

