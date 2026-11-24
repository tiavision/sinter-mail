// The structure layer's edge cases (docs/proposals/sinter-mail-mime.md, sections 2 to 4 and 8): a bare CR in a
// header block, mail.mime's cache bounds and options, mail.bytes on a Node Buffer, Content-Disposition without its
// `;`, opaque entities' Refs, near-boundary lines, shared inline sets, ranges of empty nested messages, a repeated
// Content-ID, a truncated close, multipart/report's own parts, problems of a nested root, the mbox line, and a
// structural fuzz of the scan.
import { describe, expect, test } from 'vitest';
import { mime } from '../sinter/mime.js';
import { cacheSize } from '../sinter/mime/cache.js';
import { bytes as refBytes } from '../sinter/bytes.js';
import { all, scan } from '../sinter/mime/scan.js';
import { armorKind } from '../sinter/mime/show.js';
import type { Message, Part, Ref } from '../sinter/mime/types.js';

const eml = (...lines: string[]) => lines.join('\r\n');
const enc = (s: string) => new TextEncoder().encode(s);
const multipart = (type: string, boundary: string, ...parts: string[][]) =>
  [`Content-Type: ${type}; boundary="${boundary}"`, '', ...parts.flatMap((p) => [`--${boundary}`, ...p]), `--${boundary}--`, ''];
const texts = (m: Message) => m.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'html' ? p.html : p.type));
const entities = (s: string | Uint8Array) => all(scan(typeof s === 'string' ? enc(s) : s).root);

describe('header blocks', () => {
  test('a bare CR anywhere in a header block is control-in-structure, blocking, for that entity; the reading is kept', () => {
    const root = mime(enc('X-A: b\rContent-Type: text/html\r\n\r\n<b>x</b>'));
    expect(root.parts).toMatchObject([{ id: '1', type: 'text', text: '<b>x</b>' }]);
    expect(root.problems).toEqual([{ code: 'control-in-structure', part: '1', blocking: true }]);
    expect(root.headers.raw).toEqual([['x-a', 'bContent-Type: text/html']]);
    const part = mime(eml(...multipart('multipart/mixed', 'b', ['Content-Type: text/plain', 'X-Note: a\r b', '', 'x'], ['', 'y'])));
    expect(part.problems).toEqual([{ code: 'control-in-structure', part: '1.1', blocking: true }]);
    expect(texts(part)).toEqual(['x', 'y']);
    // in a continuation line too
    expect(mime(eml('Subject: a', ' b\rc', '', 'x')).problems).toEqual([{ code: 'control-in-structure', part: '1', blocking: true }]);
    // a CR the input's end cut from its CRLF is no bare CR
    expect(mime('Subject: x\r').problems).toEqual([{ code: 'no-header-end', part: '1', blocking: false }]);
  });

  test('the mbox `From ` line is skipped only as the input\'s first line', () => {
    const line = 'From someone@example.test Mon Nov 24 09:30:00 2026';
    expect(mime(eml(line, 'Subject: s', '', 'x')).problems).toEqual([]);
    const nested = mime(eml(...multipart('multipart/mixed', 'b', ['Content-Type: message/rfc822', '', line, 'Subject: s', '', 'x'])));
    expect(nested.problems).toEqual([{ code: 'header-malformed', part: '1.1.1', blocking: true }]);
    const single = mime(eml('Content-Type: message/rfc822', '', line, 'Subject: s', '', 'x'));
    expect(single.problems).toEqual([{ code: 'header-malformed', part: '1.1', blocking: true }]);
    // a decrypted payload's root is never the input's first line
    const payload = scan(enc(eml(line, 'Subject: s', '', 'x')), { source: 'step', prefix: 'step/' });
    expect(payload.problems.map((p) => [p.entity?.id, p.code])).toEqual([['step/1', 'header-malformed']]);
  });

  test('a repeated Content-ID: the first counts, duplicate-field, blocking', () => {
    const m = mime(eml(...multipart('multipart/related; start="<two>"', 'b', ['Content-Type: text/html', 'Content-ID: <one>', 'Content-ID: <two>', '', 'A'],
      ['Content-Type: text/html', 'Content-ID: <two>', '', 'B'])));
    expect(m.problems).toEqual([{ code: 'duplicate-field', part: '1.1', blocking: true }]);
    // the first Content-ID is the part's: `start` picks the second part
    expect(texts(m)).toEqual(['B']);
    expect(m.attachments).toMatchObject([{ id: '1.1', contentId: 'one', kind: 'related' }]);
  });

  test.each([
    ['attachment filename=x.html', 'attachment'],
    ['inline foo', 'inline'],
    ['ATTACHMENT (comment) junk', 'attachment'],
  ])('Content-Disposition: %s keeps its leading token, parameter-malformed, blocking', (value, disposition) => {
    const m = mime(eml('Content-Type: text/html', `Content-Disposition: ${value}`, '', '<p>x'));
    expect(m.problems).toEqual([{ code: 'parameter-malformed', part: '1', blocking: true }]);
    if (disposition === 'attachment') {
      expect(m.parts).toEqual([]);
      expect(m.attachments).toMatchObject([{ id: '1', disposition: 'attachment', kind: 'file', filename: 'attachment' }]);
    } else {
      expect(texts(m)).toEqual(['<p>x']);
      expect(m.attachments).toEqual([]);
    }
  });

  test('a Content-Disposition that is no token at all is still ignored', () => {
    const m = mime(eml('Content-Type: text/plain', 'Content-Disposition: "attachment"', '', 'x'));
    expect(texts(m)).toEqual(['x']);
  });
});

describe('mail.mime\'s options and cache', () => {
  test('decrypted and verdicts are plain objects: a Map or a class instance throws a TypeError; a null prototype is fine', () => {
    expect(() => mime('a: b\r\n\r\n', { decrypted: new Map([['x', 1]]) as never })).toThrow(/`decrypted` is an object of results by step id \(a plain one\), not a Map/);
    expect(() => mime('a: b\r\n\r\n', { verdicts: new Map() as never })).toThrow(TypeError);
    class Results { x = [{ status: 'good' }]; }
    expect(() => mime('a: b\r\n\r\n', { verdicts: new Results() as never })).toThrow(/`verdicts` is an object .* not an instance of a class/);
    const bare = Object.create(null) as Record<string, never>;
    expect(mime('a: b\r\n\r\n', { decrypted: bare, verdicts: bare }).problems).toEqual([]);
  });

  test('a Decrypted with status ok requires its plaintext', () => {
    expect(() => mime('a: b\r\n\r\n', { decrypted: { x: { status: 'ok', integrity: true } } })).toThrow(/`decrypted\["x"\]`: `plaintext` is required with status 'ok'/);
    expect(mime('a: b\r\n\r\n', { decrypted: { x: { status: 'ok', integrity: true, plaintext: new Uint8Array(1) } } }).problems).toMatchObject([{ code: 'stale-result' }]);
  });

  test('open is copied, never spread: a huge array is read', () => {
    const open = Array.from({ length: 300_000 }, (_, i) => `x${i}`);
    expect(mime('a: b\r\n\r\n', { open }).problems).toEqual([{ code: 'stale-result', part: null, blocking: false }]);
  });

  test('the cache keeps at most 32 inputs, whatever their number', () => {
    const tiny = enc('Subject: x\r\n\r\nhi');
    for (let i = 0; i < 200_000; i++) {
      mime(tiny.slice());
      if (i % 10_000 === 0) expect(cacheSize().inputs).toBeLessThanOrEqual(32);
    }
    const size = cacheSize();
    expect(size.inputs).toBeLessThanOrEqual(32);
    expect(size.entries).toBeLessThanOrEqual(32 * 4);
    expect(size.cost).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  test('the cache counts the plaintexts its options hold: large ones evict', () => {
    const plaintext = () => ({ status: 'ok' as const, integrity: true, plaintext: new Uint8Array(6 * 1024 * 1024) });
    for (let i = 0; i < 6; i++) {
      mime(enc(`Subject: ${i}\r\n\r\nhi`), { decrypted: { x: plaintext() } });
      expect(cacheSize().cost).toBeLessThanOrEqual(16 * 1024 * 1024);
    }
    // the input just read is kept whatever its cost
    const big = enc('Subject: big\r\n\r\nhi');
    const d = { x: { status: 'ok' as const, integrity: true, plaintext: new Uint8Array(20 * 1024 * 1024) } };
    const m = mime(big, { decrypted: d });
    expect(cacheSize().inputs).toBe(1);
    mime('other');
    expect(mime(big, { decrypted: d })).toEqual(m);
    expect(cacheSize().cost).toBeLessThanOrEqual(21 * 1024 * 1024);
  });

  test('the cache counts the message read, not only its input: a large text costs about its length again', () => {
    mime.clear();
    const text = 'x'.repeat(1024 * 1024);
    const raw = enc(`Subject: s\r\n\r\n${text}`);
    mime(raw);
    expect(cacheSize().cost).toBeGreaterThan(raw.length + 2 * text.length);
  });

  test('mail.mime.clear() drops every message kept and the plaintexts they hold; the next call reads again', () => {
    const raw = enc('Subject: s\r\n\r\nhi');
    const d = { x: { status: 'ok' as const, integrity: true, plaintext: new Uint8Array(1024) } };
    const m = mime(raw, { decrypted: d });
    expect(mime(raw, { decrypted: d })).toBe(m);
    expect(cacheSize().inputs).toBeGreaterThan(0);
    mime.clear();
    expect(cacheSize()).toEqual({ inputs: 0, entries: 0, cost: 0 });
    const again = mime(raw, { decrypted: d });
    expect(again).not.toBe(m);
    expect(again).toEqual(m);
    // the call before is forgotten too: the same input and options read again after clear()
    mime.clear();
    expect(mime(raw, { decrypted: d })).not.toBe(again);
  });
});

describe('ids', () => {
  const ids = (m: Message, out: string[] = []): string[] => {
    for (const p of m.parts) { out.push(p.id); if (p.type === 'message') ids(p.message, out); }
    for (const a of m.attachments) out.push(a.id);
    return out;
  };
  test('no two parts or attachments share an id: a nested message\'s multipart root shown whole is `<id>.1`', () => {
    const outer = (inner: string) => `From: a@b.test\r\nContent-Type: multipart/mixed; boundary=o\r\n\r\n--o\r\nContent-Type: text/plain\r\n\r\nx\r\n--o\r\nContent-Type: message/rfc822\r\n\r\nSubject: n\r\n${inner}\r\n--o--\r\n`;
    const cases: [string, string[]][] = [
      // an encrypted structure as a nested message's root: one encrypted part
      ['Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary=e\r\n\r\n--e\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n--e\r\nContent-Type: application/octet-stream\r\n\r\nx\r\n--e--\r\n', ['1.1', '1.2', '1.2.1']],
      // a multipart read as one attachment of its bytes
      ['Content-Type: multipart/mixed; boundary="a b "\r\n\r\n--a b \r\nx\r\n', ['1.1', '1.2', '1.2.1']],
      // ordinary: its parts numbered under it
      ['Content-Type: multipart/mixed; boundary=q\r\n\r\n--q\r\nContent-Type: text/plain\r\n\r\nhi\r\n--q--\r\n', ['1.1', '1.2', '1.2.1']],
      ['Content-Type: text/plain\r\n\r\nhi', ['1.1', '1.2', '1.2.1']],
    ];
    for (const [inner, want] of cases) {
      const m = mime(outer(inner));
      const all = ids(m);
      expect(all).toEqual(want);
      expect(new Set(all).size).toBe(all.length);
    }
    // the problem of the shared entity still names it by its own id
    expect(mime(outer(cases[1]![0])).problems).toEqual([{ code: 'boundary-invalid', part: '1.2', blocking: true }]);
  });
});

describe('mail.bytes', () => {
  test('a Node Buffer input gives a fresh plain Uint8Array, never a view of it', () => {
    const buf = Buffer.from(eml('Content-Type: text/plain', '', 'hello'));
    const ref: Ref = { source: 'input', start: 0, end: 5, encoding: 'identity' };
    const out = refBytes(buf, ref);
    expect(Object.getPrototypeOf(out)).toBe(Uint8Array.prototype);
    out[0] = 0x58;
    expect(buf[0]).toBe(0x43);
    const sliced = refBytes(buf, { ...ref, slice: [1, 3] });
    expect(Object.getPrototypeOf(sliced)).toBe(Uint8Array.prototype);
    expect([...sliced]).toEqual([...buf.subarray(1, 3)]);
    // from a message read from the Buffer
    const m = mime(buf);
    const body = refBytes(buf, { source: 'input', start: buf.length - 5, end: buf.length, encoding: 'identity' });
    expect(new TextDecoder().decode(body)).toBe('hello');
    expect(m.parts).toMatchObject([{ type: 'text', text: 'hello' }]);
  });

  test('its bytes are over their own ArrayBuffer: a Blob takes them as they are', () => {
    const raw = eml('Content-Type: text/plain', '', 'hello');
    const out: Uint8Array<ArrayBuffer> = refBytes(raw, { source: 'input', start: raw.length - 5, end: raw.length, encoding: 'identity' });
    expect(out.buffer).toBeInstanceOf(ArrayBuffer);
    expect(new Blob([out]).size).toBe(5);
  });
});

describe('opaque entities\' Refs', () => {
  const nest = (depth: number, leaf: string[]) => {
    const b = (i: number) => `n${String(i).padStart(3, '0')}`;
    const lines = [`Content-Type: multipart/mixed; boundary=${b(0)}`, ''];
    for (let i = 1; i < depth; i++) lines.push(`--${b(i - 1)}`, `Content-Type: multipart/mixed; boundary=${b(i)}`, '');
    lines.push(`--${b(depth - 1)}`, ...leaf);
    for (let i = depth - 1; i >= 0; i--) lines.push(`--${b(i)}--`);
    return eml(...lines);
  };

  test('a leaf past the depth limit is its body, with its transfer encoding', () => {
    const s = nest(32, ['Content-Type: application/pdf', 'Content-Transfer-Encoding: base64', '', btoa('the pdf')]);
    const m = mime(s);
    expect(m.attachments).toHaveLength(1);
    const a = m.attachments[0]!;
    expect(a).toMatchObject({ contentType: 'application/pdf', kind: 'file', size: 7, ref: { encoding: 'base64' } });
    expect(new TextDecoder().decode(refBytes(s, a.ref))).toBe('the pdf');
    expect(m.problems).toEqual([{ code: 'limit', part: a.id, blocking: true }]);
  });

  test('a message/rfc822 past the depth limit is its body; a multipart past it is the whole entity', () => {
    const msg = nest(32, ['Content-Type: message/rfc822', '', 'Subject: s', '', 'body']);
    const a = mime(msg).attachments[0]!;
    expect(a).toMatchObject({ kind: 'message', contentType: 'message/rfc822', ref: { encoding: 'identity' } });
    expect(new TextDecoder().decode(refBytes(msg, a.ref))).toBe('Subject: s\r\n\r\nbody');
    const multi = nest(32, ['Content-Type: multipart/mixed; boundary=deep', '', '--deep', '', 'x', '--deep--']);
    const b = mime(multi).attachments[0]!;
    expect(new TextDecoder().decode(refBytes(multi, b.ref))).toBe('Content-Type: multipart/mixed; boundary=deep\r\n\r\n--deep\r\n\r\nx\r\n--deep--');
  });

  test('a nested message past 8 levels is its body', () => {
    let s = 'Subject: 9\r\n\r\ninnermost';
    for (let i = 8; i >= 0; i--) s = `Subject: ${i}\r\nContent-Type: message/rfc822\r\n\r\n${s}`;
    let msg = mime(s);
    while (msg.parts[0]?.type === 'message') msg = msg.parts[0].message;
    expect(new TextDecoder().decode(refBytes(s, msg.attachments[0]!.ref))).toBe('Subject: 9\r\n\r\ninnermost');
  });

  test('the overflow past the part limit and a boundary-invalid multipart are the whole of their bytes', () => {
    const parts = Array.from({ length: 1002 }, (_, i) => ['', `p${i + 1}`]);
    const s = eml(...multipart('multipart/mixed', 'b', ...parts));
    const over = mime(s).attachments[0]!;
    expect(new TextDecoder().decode(refBytes(s, over.ref))).toMatch(/^\r\np1000\r\n--b\r\n\r\np1001\r\n/);
    const bad = eml(...multipart('multipart/mixed', 'b', ['Content-Type: multipart/mixed; boundary="b2"', '', '--b2', '', 'x', '--b2--']));
    const a = mime(bad).attachments[0]!;
    expect(new TextDecoder().decode(refBytes(bad, a.ref))).toMatch(/^Content-Type: multipart\/mixed; boundary="b2"/);
  });
});

describe('near-boundary lines', () => {
  test('32 open boundaries sharing a 69-byte prefix: 32 MB of `--<prefix>!` lines scan within ~3x a plain body', () => {
    const pre = 'p'.repeat(69);
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
    let head = '';
    for (let i = 0; i < 32; i++) head += `Content-Type: multipart/mixed; boundary="${pre}${chars[i]}"\r\n\r\n--${pre}${chars[i]}\r\n`;
    head += 'Content-Type: application/octet-stream\r\n\r\n';
    const line = `--${pre}!\r\n`, n = Math.floor(32 * 1024 * 1024 / line.length);
    const hostile = enc(head + line.repeat(n));
    const plain = enc(head + `xx${pre}!\r\n`.repeat(n));
    const time = (src: Uint8Array) => { const t = performance.now(); scan(src); return performance.now() - t; };
    time(plain); time(hostile);
    let a = Infinity, b = Infinity;
    for (let k = 0; k < 3; k++) { a = Math.min(a, time(plain)); b = Math.min(b, time(hostile)); }
    expect(b).toBeLessThan(3.5 * a + 20);
    // and the lines are still read right: no delimiter among them, every multipart unclosed
    const s = scan(hostile);
    expect(s.problems.filter((p) => p.code === 'boundary-missing-close')).toHaveLength(32);
  });

  test('the delimiter rules hold: padding, the close, `--` in a boundary, a longer line', () => {
    const s = eml('Content-Type: multipart/mixed; boundary="a-"', '', '--a- \t', '', 'one', '--a---\t', '');
    expect(entities(s).map((e) => [e.id, e.closed])).toEqual([['1', true], ['1.1', false]]);
    expect(texts(mime(s))).toEqual(['one']);
    // `--a--` of a child `a` inside a parent `a--` is refused; `--ab` is not `--a`
    const longer = eml(...multipart('multipart/mixed', 'a', ['', '--ab', '--a x', 'body']));
    expect(texts(mime(longer))).toEqual(['--ab\r\n--a x\r\nbody']);
    const tooLong = eml(...multipart('multipart/mixed', 'a', ['', `--a${'-'.repeat(80)}`]));
    expect(texts(mime(tooLong))).toEqual([`--a${'-'.repeat(80)}`]);
  });

  test('a close delimiter followed by a bare CR at the very end of the input is a close', () => {
    const m = mime('Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\nx\r\n--b--\r');
    expect(m.problems).toEqual([]);
    expect(texts(m)).toEqual(['x']);
    // not at the end: a CR before more text is a character of the line
    const mid = mime('Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\nx\r\n--b--\rx');
    expect(mid.problems).toMatchObject([{ code: 'boundary-missing-close', blocking: true }]);
  });
});

describe('inline sets', () => {
  test('499 HTML parts beside 499 Content-IDs share one frozen set of the first 64: built once, still right, JSON linear', () => {
    let s = 'Content-Type: multipart/mixed; boundary=m\r\n\r\n';
    for (let i = 0; i < 499; i++) s += '--m\r\nContent-Type: text/html\r\n\r\n';
    for (let i = 0; i < 499; i++) s += `--m\r\nContent-Type: image/png\r\nContent-ID: <${i}@x>\r\n\r\n`;
    s += '--m--';
    const t = performance.now();
    const m = mime(s);
    expect(performance.now() - t).toBeLessThan(2000);
    const html = m.parts as (Part & { type: 'html' })[];
    expect(html).toHaveLength(499);
    const set = html[0]!.inline;
    // the message-wide fallback is capped at 64 per part, in document order (show.MAX_INLINE_ELSEWHERE)
    expect(set).toHaveLength(64);
    expect(set).toEqual(m.attachments.slice(0, 64).map((a, i) => ({ contentId: `${i}@x`, attachment: a.id })));
    expect(set[7]).toEqual({ contentId: '7@x', attachment: m.attachments[7]!.id });
    // serialized, the shared set is written once per part: bounded by the cap, not quadratic
    expect(JSON.stringify(m).length).toBeLessThan(3_000_000);
    expect(Object.isFrozen(set)).toBe(true);
    for (const p of html) expect(p.inline).toBe(set);
    // one set held, however many parts show it: the distinct objects are linear in the input
    const distinct = new Set<unknown>();
    const stack: unknown[] = [m];
    while (stack.length) {
      const x = stack.pop();
      if (typeof x !== 'object' || x === null || distinct.has(x)) continue;
      distinct.add(x);
      for (const v of Object.values(x)) stack.push(v);
    }
    expect(distinct.size).toBeLessThan(20_000);
  });

  test('the cap is on the message-wide fallback only: a part\'s own related parts are all in its set', () => {
    const own = Array.from({ length: 70 }, (_, i) => ['--r', 'Content-Type: image/png', `Content-ID: <own${i}>`, '', 'P']).flat();
    const out = Array.from({ length: 70 }, (_, i) => ['Content-Type: image/png', `Content-ID: <out${i}>`, '', 'Q']);
    const m = mime(eml(...multipart('multipart/mixed', 'm',
      ['Content-Type: multipart/related; boundary=r', '', '--r', 'Content-Type: text/html', '', 'b', ...own, '--r--'], ...out)));
    const set = (m.parts[0] as Part & { type: 'html' }).inline;
    expect(set).toHaveLength(70 + 64);
    expect(set.slice(0, 70).map((x) => x.contentId)).toEqual(Array.from({ length: 70 }, (_, i) => `own${i}`));
    expect(set.slice(70).map((x) => x.contentId)).toEqual(Array.from({ length: 64 }, (_, i) => `out${i}`));
    expect(m.problems).toEqual([]);
  });

  test('parts with another related scope or protection get their own set', () => {
    const m = mime(eml(...multipart('multipart/mixed', 'm',
      ['Content-Type: text/html', '', 'a'],
      ['Content-Type: multipart/related; boundary=r', '', '--r', 'Content-Type: text/html', '', 'b', '--r', 'Content-Type: image/png', 'Content-ID: <own>', '', 'P', '--r--'],
      ['Content-Type: text/html', '', 'c'],
      ['Content-Type: image/png', 'Content-ID: <out>', '', 'Q'])));
    const [a, b, c] = m.parts as (Part & { type: 'html' })[];
    expect(a!.inline).toBe(c!.inline);
    // elsewhere in the message, a related part is still a unique Content-ID
    expect(a!.inline).toEqual([{ contentId: 'own', attachment: '1.2.2' }, { contentId: 'out', attachment: '1.4' }]);
    expect(b!.inline).not.toBe(a!.inline);
    expect(b!.inline).toEqual([{ contentId: 'own', attachment: '1.2.2' }, { contentId: 'out', attachment: '1.4' }]);
  });

  test('armorKind looks for the BEGIN line before splitting', () => {
    expect(armorKind('\r\n -----BEGIN PGP MESSAGE-----\r\nx\r\n-----END PGP MESSAGE-----\r\n')).toBe('message');
    expect(armorKind('hello\n-----BEGIN PGP MESSAGE-----\nx\n-----END PGP MESSAGE-----')).toBe(null);
    const big = 'x\n'.repeat(10_000_000);
    const t = performance.now();
    expect(armorKind(big)).toBe(null);
    expect(performance.now() - t).toBeLessThan(100);
  });
});

describe('the tree', () => {
  test('a message/rfc822 with an empty body before a delimiter: its root is within it', () => {
    const s = eml(...multipart('multipart/mixed', 'b', ['Content-Type: message/rfc822', '']));
    const es = entities(s);
    const msg = es.find((e) => e.id === '1.1')!, root = msg.message!;
    expect([root.start, root.bodyStart, root.end]).toEqual([msg.end, msg.end, msg.end]);
    expect(root.start).toBeGreaterThanOrEqual(msg.bodyStart);
    const m = mime(s);
    expect(m.parts).toMatchObject([{ id: '1.1', type: 'message', ref: { start: msg.bodyStart, end: msg.end } }]);
  });

  test('multipart/report: only its own parts take its role; a message attachment deeper inside stays an attachment', () => {
    const returned = ['Content-Type: message/rfc822', 'Content-Disposition: attachment', '', 'Subject: s', '', 'body'];
    const mixed = mime(eml(...multipart('multipart/report', 'b', ['Content-Type: multipart/mixed; boundary=c', '', '--c', ...returned, '--c--'])));
    expect(mixed.parts).toEqual([]);
    expect(mixed.attachments).toMatchObject([{ id: '1.1.1', kind: 'message', disposition: 'attachment' }]);
    const alt = mime(eml(...multipart('multipart/report', 'b', ['Content-Type: multipart/alternative; boundary=c', '', '--c', ...returned, '--c--'])));
    expect(alt.attachments).toMatchObject([{ id: '1.1.1', kind: 'message' }]);
    const own = mime(eml(...multipart('multipart/report', 'b', ['', 'human'], returned)));
    expect(own.parts.map((p) => p.type)).toEqual(['text', 'message']);
  });

  test('a nested multipart root shares its message entity\'s id: their problems are listed together, blocking kept', () => {
    const s = eml(...multipart('multipart/mixed', 'b', [
      'Content-Type: message/rfc822', 'Content-Transfer-Encoding: base64', 'Content-Type: message/rfc822', '',
      'Content-Type: multipart/mixed; boundary=in', 'Content-Type: multipart/mixed; boundary=in', '', '--in', '', 'x',
    ]));
    const es = entities(s);
    const msg = es.find((e) => e.type === 'message/rfc822')!;
    expect(msg.message!.id).toBe(msg.id);
    expect(msg.message!.blocking).toEqual(['duplicate-field', 'boundary-missing-close']);
    expect(msg.blocking).toEqual(['duplicate-field', 'encoding-on-multipart']);
    const m = mime(s);
    expect(m.problems.filter((p) => p.part === '1.1')).toEqual([
      { code: 'duplicate-field', part: '1.1', blocking: true },
      { code: 'encoding-on-multipart', part: '1.1', blocking: true },
      { code: 'boundary-missing-close', part: '1.1', blocking: true },
    ]);
  });
});

describe('structural fuzz', () => {
  test('2,000 seeded random structures: no throw, unique ids, Refs within their source, children within parents', () => {
    let seed = 20261124;
    const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed % n; };
    const toks = ['--a', '--b', '--a--', '--b--', '--c', '--c--', '--a-- ', '--b\t', '--', '',
      'Content-Type: multipart/mixed; boundary=a', 'Content-Type: multipart/alternative; boundary=b', 'Content-Type: multipart/related; boundary="a--"; start="<x>"',
      'Content-Type: multipart/digest; boundary=c', 'Content-Type: multipart/report; boundary=b', 'Content-Type: message/rfc822', 'Content-Type: message/global',
      'Content-Type: text/html', 'Content-Type: text/plain; charset=x', 'Content-Type: text/calendar', 'Content-Type: application/octet-stream',
      'Content-Transfer-Encoding: base64', 'Content-Transfer-Encoding: quoted-printable', 'Content-Transfer-Encoding: x', 'Content-ID: <x>',
      'Content-Disposition: attachment; filename="a.txt"', 'Content-Disposition: attachment filename=b', '', '', 'text=', 'QUJD=QQ==', ' ', 'From x', 'nocolon',
      '-----BEGIN PGP MESSAGE-----', '-----END PGP MESSAGE-----', 'Content-Type: multipart/signed; boundary=b; protocol="application/pgp-signature"',
      'Content-Type: application/pgp-signature', 'Content-Type: multipart/encrypted; boundary=a; protocol="application/pgp-encrypted"',
      'Content-Type: application/pgp-encrypted', 'Version: 1'];
    const ends = ['\r\n', '\r\n', '\r\n', '\n', '\r', ''];
    const refs = (m: Message, out: Ref[]) => {
      for (const a of m.attachments) out.push(a.ref);
      for (const s of m.steps) {
        if (s.kind === 'decrypt') out.push(s.ciphertext);
        else if (s.kind === 'verify') out.push(s.signed, s.signature);
        else out.push(s.block);
      }
      for (const p of m.parts) {
        if (p.type === 'message') { out.push(p.ref); refs(p.message, out); }
        if (p.type === 'encrypted') out.push(p.ref);
      }
      return out;
    };
    for (let it = 0; it < 2000; it++) {
      const n = 1 + rnd(40);
      let s = '';
      for (let i = 0; i < n; i++) s += toks[rnd(toks.length)]! + ends[rnd(ends.length)]!;
      const src = enc(s);
      const where = JSON.stringify(s);
      let m: Message;
      try { m = mime(src, { prefer: rnd(2) ? 'html' : 'text' }); } catch (e) { throw new Error(`threw ${String(e)} on ${where}`); }
      const es = all(scan(src).root);
      const ids = new Set<string>();
      for (const e of es) {
        expect(e.start <= e.bodyStart && e.bodyStart <= e.end && e.end <= src.length, where).toBe(true);
        const p = e.parent;
        if (p) expect(e.start >= p.bodyStart && e.end <= p.end, `${e.id} outside ${p.id} in ${where}`).toBe(true);
        // a nested multipart root shares its message entity's id; every other id is unique
        if (!(p && p.message === e && e.id === p.id)) { expect(ids.has(e.id), where).toBe(false); ids.add(e.id); }
      }
      const seen = new Set<string>();
      const unique = (x: Message) => {
        for (const a of x.attachments) { expect(seen.has('a' + a.id), where).toBe(false); seen.add('a' + a.id); }
        for (const p of x.parts) { expect(seen.has('p' + p.id), where).toBe(false); seen.add('p' + p.id); if (p.type === 'message') unique(p.message); }
      };
      unique(m);
      for (const r of refs(m, [])) {
        expect(r.source).toBe('input');
        expect(r.start <= r.end && r.end <= src.length, where).toBe(true);
        expect(() => refBytes(src, r), where).not.toThrow();
      }
      JSON.stringify(m);
    }
  });
});
