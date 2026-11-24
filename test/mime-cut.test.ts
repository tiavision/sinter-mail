// Cut messages (docs/mail.md, "Large attachments: cut messages"): mail.cut, the `holes` option, the reader's check
// of each hole, Refs with `missing`, mail.bytes with `fetched`, steps over cut bytes, and the cache.
import { describe, expect, test } from 'vitest';
import { cut, mime } from '../sinter/mime.js';
import { bytes as refBytes } from '../sinter/bytes.js';
import type { Attachment, Hole, Message, Part, Ref } from '../sinter/mime/types.js';

const eml = (...lines: string[]) => lines.join('\r\n');
const HEAD = ['From: A <a@example.test>', 'To: b@example.test', 'Subject: test', 'MIME-Version: 1.0'];
const multipart = (type: string, boundary: string, ...parts: string[][]) =>
  [`Content-Type: ${type}; boundary="${boundary}"`, '', ...parts.flatMap((p) => [`--${boundary}`, ...p]), `--${boundary}--`, ''];
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** `n` bytes of data as base64 lines of 76 */
function base64Lines(n: number, seed = 1): string[] {
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = (i * 31 + seed) & 0xff;
  const b64 = Buffer.from(data).toString('base64');
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out;
}
const pdf = (n: number, name = 'big.pdf') =>
  [`Content-Type: application/pdf; name="${name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${name}"`, '', ...base64Lines(n)];
const TEXT = ['Content-Type: text/plain', '', 'two lines', 'of text'];

/** the bytes of `ref`, fetching what was cut from the whole message `whole` */
const fetchRef = (whole: Uint8Array, input: Uint8Array, ref: Ref) =>
  refBytes(input, ref, ref.missing ? { fetched: whole.subarray(ref.missing.start, ref.missing.end) } : undefined);

const att = (m: Message, i = 0) => m.attachments[i]!;

describe('mail.cut and the reader', () => {
  const whole = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', TEXT, pdf(200_000))));

  test('a large attachment is cut; the text reads as from the whole message', () => {
    const c = cut(whole);
    expect(c.holes).toHaveLength(1);
    expect(c.raw.length).toBe(whole.length - (c.holes[0]!.end - c.holes[0]!.start));
    const full = mime(whole), part = mime(c.raw, { holes: c.holes });
    expect(part.cut).toBe('valid');
    expect(full.cut).toBe(null);
    expect(part.parts).toEqual(full.parts);
    expect(part.problems).toEqual(full.problems);
    expect(att(part).size).toBe(200_000);
    expect(att(part).size).toBe(att(full).size);
    expect(att(part).ref.missing).toEqual({ start: c.holes[0]!.start, end: c.holes[0]!.end, gaps: [[0, c.holes[0]!.end - c.holes[0]!.start]] });
  });

  test('mail.bytes reads a cut attachment from the fetched range, the same bytes as from the whole message', () => {
    const c = cut(whole);
    const part = mime(c.raw, { holes: c.holes }), full = mime(whole);
    expect(fetchRef(whole, c.raw, att(part).ref)).toEqual(refBytes(whole, att(full).ref));
    expect(() => refBytes(c.raw, att(part).ref)).toThrow(/fetch bytes \d+ to \d+ of the whole message/);
    const m = att(part).ref.missing!;
    expect(() => refBytes(c.raw, att(part).ref, { fetched: whole.subarray(m.start, m.end - 1) })).toThrow(/bytes of the ref's range/);
  });

  test('small parts stay; thresholds and the cap choose the largest first', () => {
    const s = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', TEXT, pdf(100_000, 'a.pdf'), pdf(300_000, 'b.pdf'), pdf(1_000, 'c.pdf'))));
    expect(cut(s).holes).toHaveLength(2);
    const one = cut(s, { max: 1 });
    expect(one.holes).toHaveLength(1);
    const m = mime(one.raw, { holes: one.holes });
    expect(m.attachments.map((a) => [a.filename, !!a.ref.missing])).toEqual([['a.pdf', false], ['b.pdf', true], ['c.pdf', false]]);
    expect(cut(s, { over: 1_000_000 }).holes).toEqual([]);
  });

  test('an image of a multipart/related has its own threshold, and a cut cid image is fetched like any attachment', () => {
    const img = ['Content-Type: image/png', 'Content-Transfer-Encoding: base64', 'Content-ID: <logo@x>', '', ...base64Lines(200_000)];
    const s = enc(eml(...HEAD, ...multipart('multipart/related', 'r', ['Content-Type: text/html', '', '<img src="cid:logo@x">'], img)));
    expect(cut(s).holes).toEqual([]);
    const c = cut(s, { relatedOver: 1024 });
    const m = mime(c.raw, { holes: c.holes });
    const html = m.parts[0] as Part & { type: 'html' };
    expect(html.inline).toEqual([{ contentId: 'logo@x', attachment: '1.2' }]);
    const a = m.attachments.find((x) => x.id === '1.2')!;
    expect(fetchRef(s, c.raw, a.ref)).toEqual(refBytes(s, mime(s).attachments[0]!.ref));
  });

  test('text, message, PGP control parts and malformed neighbours are never cut', () => {
    const bigText = ['Content-Type: text/plain', 'Content-Disposition: attachment; filename="log.txt"', '', ...base64Lines(200_000)];
    const s = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', TEXT, bigText, ['Content-Type: message/rfc822', '', ...HEAD, 'Content-Type: text/plain', '', ...base64Lines(200_000)])));
    expect(cut(s).holes).toEqual([]);
    // a duplicate Content-Type is blocking: nothing in or below it is cut
    const dup = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', TEXT, ['Content-Type: application/pdf', ...pdf(200_000)])));
    expect(cut(dup).holes).toEqual([]);
  });

  test('a body with a line starting `--`, or ending with a CR, is not cut', () => {
    const lines = ['Content-Type: application/octet-stream', '', 'data', '--not a boundary', ...Array(20_000).fill('xxxxxxxxxx')];
    expect(cut(enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', TEXT, lines))), { over: 10 }).holes).toEqual([]);
    const cr = eml(...HEAD, ...multipart('multipart/mixed', 'b', TEXT, ['Content-Type: application/octet-stream', '', 'abc\r']));
    expect(cut(enc(cr), { over: 1 }).holes).toEqual([]);
  });

  test('a forwarded message sent as an attachment: the PDF inside is cut, its Ref spans the hole', () => {
    const inner = [...HEAD, ...multipart('multipart/mixed', 'in', TEXT, pdf(200_000))];
    const s = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', TEXT, ['Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="fwd.eml"', '', ...inner])));
    const c = cut(s);
    expect(c.holes).toHaveLength(1);
    const m = mime(c.raw, { holes: c.holes }), full = mime(s);
    const a = m.attachments.find((x) => x.kind === 'message')!;
    const fa = full.attachments.find((x) => x.kind === 'message')!;
    expect(a.ref.missing).toBeDefined();
    expect(a.size).toBe(fa.size);
    const got = fetchRef(s, c.raw, a.ref);
    expect(got).toEqual(refBytes(s, fa.ref));
    // read again as its own message, it is whole
    expect(mime(got).attachments[0]!.size).toBe(200_000);
  });

  test('a forwarded message shown inline: its own cut attachment has `missing`', () => {
    const inner = [...HEAD, ...multipart('multipart/mixed', 'in', TEXT, pdf(200_000))];
    const s = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', TEXT, ['Content-Type: message/rfc822', '', ...inner])));
    const c = cut(s);
    const m = mime(c.raw, { holes: c.holes });
    const nested = m.parts.find((p) => p.type === 'message') as Part & { type: 'message' };
    expect(nested.ref.missing).toBeDefined();
    const a = nested.message.attachments[0]!;
    expect(a.size).toBe(200_000);
    expect(fetchRef(s, c.raw, a.ref)).toEqual(refBytes(s, (mime(s).parts.find((p) => p.type === 'message') as Part & { type: 'message' }).message.attachments[0]!.ref));
  });
});

describe('the reader checks every hole', () => {
  const whole = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', TEXT, pdf(200_000))));
  const good = cut(whole);
  const read = (holes: Hole[], raw = good.raw) => mime(raw, { holes });

  test('a hole that lands on no empty leaf body is hole-mismatch: blocking, cut invalid', () => {
    const h = good.holes[0]!;
    const m = read([{ ...h, start: h.start - 1, end: h.end - 1 }]);
    expect(m.cut).toBe('invalid');
    expect(m.problems).toContainEqual({ code: 'hole-mismatch', part: '1', blocking: true });
  });

  test('a size larger than the cut bytes can decode to is hole-mismatch', () => {
    const h = good.holes[0]!;
    expect(read([{ ...h, size: h.end - h.start }]).cut).toBe('invalid');
    expect(read([h]).cut).toBe('valid');
  });

  test('holes out of order, overlapping or past the input are hole-mismatch, and no Ref is marked', () => {
    const h = good.holes[0]!;
    const m = read([h, h]);
    expect(m.cut).toBe('invalid');
    expect(m.attachments[0]!.ref.missing).toBeUndefined();
    expect(read([{ start: whole.length * 2, end: whole.length * 2 + 5, size: 1 }]).cut).toBe('invalid');
    expect(read([{ start: 10, end: 10, size: 0 }]).cut).toBe('invalid');
  });

  test('a cut text part is refused: its empty body is shown, and the message is invalid', () => {
    const s = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', ['Content-Type: text/plain', '', 'secret text'], pdf(10))));
    const at = dec(s).indexOf('secret text');
    const cutRaw = new Uint8Array([...s.subarray(0, at), ...s.subarray(at + 'secret text'.length)]);
    const m = mime(cutRaw, { holes: [{ start: at, end: at + 11, size: 11 }] });
    expect(m.cut).toBe('invalid');
    expect(m.problems.find((p) => p.code === 'hole-mismatch')!.blocking).toBe(true);
  });

  test('a cut application/pgp-encrypted control part is refused', () => {
    const s = eml(...HEAD, ...multipart('multipart/encrypted; protocol="application/pgp-encrypted"', 'e',
      ['Content-Type: application/pgp-encrypted', '', 'Version: 1'], ['Content-Type: application/octet-stream', '', '-----BEGIN PGP MESSAGE-----', 'abc', '-----END PGP MESSAGE-----']));
    const at = s.indexOf('Version: 1');
    const raw = enc(s.slice(0, at) + s.slice(at + 10));
    expect(mime(raw, { holes: [{ start: at, end: at + 10, size: 10 }] }).cut).toBe('invalid');
  });

  test('mail.cut\'s option shapes are checked', () => {
    expect(() => cut('x', { rootCiphertext: 'yes' as never })).toThrow(/`rootCiphertext` is true or false/);
    expect(() => cut('x', { over: -1 })).toThrow(/`over`/);
  });

  test('invalid option shapes throw', () => {
    expect(() => mime(good.raw, { holes: 'x' as never })).toThrow(/`holes` is an array/);
    expect(() => mime(good.raw, { holes: [{ start: -1, end: 2, size: 0 }] })).toThrow(/`holes\[0\]`/);
  });

  test('mail.bytes refuses fetched bytes that differ outside the gap, or hold a line starting `--`', () => {
    const m = read(good.holes);
    const ref = att(m).ref, miss = ref.missing!;
    const f = whole.slice(miss.start, miss.end);
    expect(refBytes(good.raw, ref, { fetched: f }).length).toBe(200_000);
    const bad = f.slice();
    bad[0] = 0x2d; bad[1] = 0x2d;
    expect(() => refBytes(good.raw, ref, { fetched: bad })).toThrow(/starting with `--`/);
    // a Ref spanning the gap: bytes outside it are checked against the input
    const r2: Ref = { source: 'input', start: ref.start - 4, end: ref.end, encoding: 'identity', missing: { start: miss.start - 4, end: miss.end, gaps: [[4, miss.end - miss.start]] } };
    const g = whole.slice(miss.start - 4, miss.end);
    expect(refBytes(good.raw, r2, { fetched: g }).length).toBe(g.length);
    g[0] = (g[0]! + 1) & 0xff;
    expect(() => refBytes(good.raw, r2, { fetched: g })).toThrow(/differs from the message/);
  });
});

describe('steps over cut bytes', () => {
  const armored = ['-----BEGIN PGP SIGNATURE-----', '', 'iQ==', '-----END PGP SIGNATURE-----'];
  const signed = eml(...HEAD, ...multipart('multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha256', 's',
    [...multipart('multipart/mixed', 'b', TEXT, pdf(200_000)).slice(0, -1)],
    ['Content-Type: application/pgp-signature', '', ...armored]));

  test('a signed message with a cut attachment: the verify step is incomplete, takes no result, its parts pending', () => {
    const whole = enc(signed);
    const c = cut(whole);
    expect(c.holes).toHaveLength(1);
    const m = mime(c.raw, { holes: c.holes });
    expect(m.cut).toBe('valid');
    expect(m.steps).toHaveLength(1);
    const step = m.steps[0]!;
    expect(step).toMatchObject({ kind: 'verify', state: 'pending', incomplete: true, id: '1#cut' });
    expect(m.parts[0]!.protection.signed).toBe('pending');
    // a result for it is stale, and labels nothing
    const v = mime(c.raw, { holes: c.holes, verdicts: { [step.id]: [{ status: 'good', signer: ['a@example.test'] }] } });
    expect(v.steps[0]!.state).toBe('pending');
    expect(v.parts[0]!.protection.signed).toBe('pending');
    expect(v.problems.map((p) => p.code)).toContain('stale-result');
    // the whole message has the real step, with a digest id
    const full = mime(whole);
    expect(full.steps[0]!.id).toMatch(/^1#[0-9a-f]+$/);
    expect(full.steps[0]!.incomplete).toBeUndefined();
    expect(full.parts).toEqual(m.parts.map((p) => ({ ...p, protection: { ...p.protection, step: full.steps[0]!.id } })));
  });

  test('a hole the reader refuses in a signed message: no step is offered, nothing is labelled', () => {
    const whole = enc(signed);
    const c = cut(whole);
    const h = c.holes[0]!;
    const m = mime(c.raw, { holes: [{ ...h, size: h.end - h.start }] });
    expect(m.cut).toBe('invalid');
    expect(m.steps).toEqual([]);
    expect(m.parts[0]!.protection.signed).toBe(null);
  });

  test('a base64 ciphertext (Exchange\'s shape) cut out: an incomplete decrypt step and an incomplete part', () => {
    const s = enc(eml(...HEAD, ...multipart('multipart/mixed', 'x',
      ['Content-Type: application/pgp-encrypted', '', 'Version: 1'],
      ['Content-Type: application/octet-stream; name="encrypted.asc"', 'Content-Transfer-Encoding: base64', '', ...base64Lines(200_000)])));
    // the root's ciphertext: not cut by default (the app fetches the whole message to decrypt anyway)
    expect(cut(s).holes).toEqual([]);
    const c = cut(s, { rootCiphertext: true });
    expect(c.holes).toHaveLength(1);
    const m = mime(c.raw, { holes: c.holes });
    const full = mime(s);
    expect(full.steps[0]).toMatchObject({ kind: 'decrypt' });
    expect(m.steps).toEqual([expect.objectContaining({ kind: 'decrypt', state: 'pending', incomplete: true, id: '1#cut' })]);
    expect(m.parts).toEqual([expect.objectContaining({ type: 'encrypted', reason: 'incomplete', step: '1#cut' })]);
    expect((m.parts[0] as Part & { type: 'encrypted' }).ref.missing).toBeDefined();
  });

  test('sign over encrypt: the root\'s ciphertext inside the signed part is not cut by default', () => {
    const exchange = ['Content-Type: multipart/mixed; boundary="x"', '', '--x', 'Content-Type: application/pgp-encrypted', '', 'Version: 1',
      '--x', 'Content-Type: application/octet-stream', 'Content-Transfer-Encoding: base64', '', ...base64Lines(200_000), '--x--'];
    const s = enc(eml(...HEAD, ...multipart('multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha256', 's',
      exchange, ['Content-Type: application/pgp-signature', '', '-----BEGIN PGP SIGNATURE-----', '', 'iQ==', '-----END PGP SIGNATURE-----'])));
    expect(cut(s).holes).toEqual([]);
    expect(cut(s, { rootCiphertext: true }).holes).toHaveLength(1);
  });

  test('an armored PGP/MIME ciphertext is never cut: its lines start with `--`', () => {
    const s = enc(eml(...HEAD, ...multipart('multipart/encrypted; protocol="application/pgp-encrypted"', 'e',
      ['Content-Type: application/pgp-encrypted', '', 'Version: 1'],
      ['Content-Type: application/octet-stream', '', '-----BEGIN PGP MESSAGE-----', '', ...base64Lines(200_000), '-----END PGP MESSAGE-----'])));
    expect(cut(s).holes).toEqual([]);
  });
});

/** `whole` with `[start, end)` cut out, and its hole (size: `size`, else the length) */
function cutAt(whole: string, start: number, end: number, size = end - start) {
  return { raw: enc(whole.slice(0, start) + whole.slice(end)), holes: [{ start, end, size }] };
}

describe('review findings', () => {
  test('a part whose blank line is the delimiter\'s line break: a hole there is in its header block, refused', () => {
    const x = 'Content-Disposition: attachment; filename="invoice.pdf.exe"\r\nContent-ID: <logo@x>\r\nContent-Transfer-Encoding: base64\r\n\r\nTVqQ';
    const pre = eml(...HEAD, 'Content-Type: multipart/mixed; boundary="b"', '', '--b', ...TEXT, '--b', 'Content-Type: application/pdf; name="invoice.pdf"', '');
    const whole = pre + x + '\r\n--b--\r\n';
    expect(mime(whole).attachments[0]!.filename).toBe('invoice.pdf.exe');
    const c = cutAt(whole, pre.length, pre.length + x.length);
    expect(mime(c.raw, { holes: c.holes }).cut).toBe('invalid');
    // with a whitespace-only line, which the reader folds into the header, the same
    const pre2 = eml(...HEAD, 'Content-Type: multipart/mixed; boundary="b"', '', '--b', ...TEXT, '--b', 'Content-Type: application/pdf; name="invoice.pdf"', ' ', '');
    const c2 = cutAt(pre2 + x + '\r\n--b--\r\n', pre2.length, pre2.length + x.length);
    expect(mime(c2.raw, { holes: c2.holes }).cut).toBe('invalid');
    // and in a bare-LF message
    const lf = pre.replaceAll('\r\n', '\n');
    const c3 = cutAt(lf + x.replaceAll('\r\n', '\n') + '\n--b--\n', lf.length, lf.length + x.replaceAll('\r\n', '\n').length);
    expect(mime(c3.raw, { holes: c3.holes }).cut).toBe('invalid');
  });

  const cleartext = ['Content-Type: text/plain', '', '-----BEGIN PGP SIGNED MESSAGE-----', 'Hash: SHA256', '', 'signed text', '-----BEGIN PGP SIGNATURE-----', '', 'iQ==', '-----END PGP SIGNATURE-----'];

  test('a cut body that hides a delimiter: a cleartext block is not the signature over the message', () => {
    const body = 'JVBERi0x\r\n--b \r\nContent-Type: text/html\r\n\r\n<h1>unsigned extra</h1>';
    const pre = eml(...HEAD, 'Content-Type: multipart/mixed; boundary="b"', '', '--b', ...cleartext, '--b', 'Content-Type: application/pdf', '', '');
    const whole = pre + body + '\r\n--b--\r\n';
    const c = cutAt(whole, pre.length, pre.length + body.length);
    const m = mime(c.raw, { holes: c.holes });
    expect(m.cut).toBe('valid');
    const step = m.steps.find((x) => x.kind === 'verify-cleartext')!;
    expect(step).toMatchObject({ incomplete: true, id: '1.1:1#cut' });
    const v = mime(c.raw, { holes: c.holes, verdicts: { [step.id]: [{ status: 'good', signer: ['a@example.test'] }] } });
    expect(v.parts[0]!.protection.signed).toBe('pending');
    expect(v.summary.from).not.toBe('matches');
    // the same message whole, without the trick, does bind the From: only the cut withholds it
    const plain = eml(...HEAD, ...multipart('multipart/mixed', 'b', cleartext, ['Content-Type: application/pdf', '', ...base64Lines(100_000)]));
    const pc = cut(enc(plain));
    const ps = mime(pc.raw, { holes: pc.holes }).steps[0]!;
    expect(mime(pc.raw, { holes: pc.holes, verdicts: { [ps.id]: [{ status: 'good', signer: ['a@example.test'] }] } }).summary.from).not.toBe('matches');
    // and fetching the hidden bytes is refused
    const ref = m.attachments[0]!.ref;
    expect(() => fetchRef(enc(whole), c.raw, ref)).toThrow(/starting with `--`/);
  });

  test('in a cut message an armored text is never the root decrypt step', () => {
    const armoredText = ['Content-Type: text/plain', '', '-----BEGIN PGP MESSAGE-----', '', 'hQ==', '-----END PGP MESSAGE-----'];
    const s = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', armoredText, pdf(200_000))));
    expect(mime(s).steps.map((x) => x.kind)).toEqual(['decrypt']);
    const c = cut(s);
    const m = mime(c.raw, { holes: c.holes });
    expect(m.steps).toEqual([]);
    expect(m.parts[0]).toMatchObject({ type: 'encrypted', reason: 'not-root' });
  });

  test('an identity body\'s size must be its length', () => {
    const s = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', TEXT, ['Content-Type: application/octet-stream', '', 'x'.repeat(1000)])));
    const c = cut(s, { over: 10 });
    expect(c.holes[0]!.size).toBe(1000);
    expect(mime(c.raw, { holes: c.holes }).cut).toBe('valid');
    expect(mime(c.raw, { holes: [{ ...c.holes[0]!, size: 0 }] }).cut).toBe('invalid');
  });

  test('an incomplete verify step reads its signed bytes canonical', () => {
    const s = enc(eml(...HEAD, ...multipart('multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha256', 's',
      ['Content-Type: application/octet-stream', '', 'ab\ncd'], ['Content-Type: application/pgp-signature', '', '-----BEGIN PGP SIGNATURE-----', '', 'iQ==', '-----END PGP SIGNATURE-----'])));
    const full = mime(s);
    expect(full.steps[0]!.kind === 'verify' && full.steps[0]!.signed.canonical).toBe(true);
    const c = cut(s, { over: 1 });
    const step = mime(c.raw, { holes: c.holes }).steps[0]!;
    expect(step.kind === 'verify' && step.signed.canonical).toBe(true);
    if (step.kind === 'verify' && full.steps[0]!.kind === 'verify') expect(fetchRef(s, c.raw, step.signed)).toEqual(refBytes(s, full.steps[0]!.signed));
  });
});

describe('second review: every step of a cut message is incomplete', () => {
  /** `whole` with the bytes from just after `startMark` up to `endMark` cut out, as an identity body */
  const withHole = (whole: string, startMark: string, endMark: string) => {
    const a = whole.indexOf(startMark) + startMark.length, b = whole.indexOf(endMark, a);
    return { raw: enc(whole.slice(0, a) + whole.slice(b)), holes: [{ start: a, end: b, size: b - a }] };
  };
  const good = (m: Message) => Object.fromEntries(m.steps.map((s) => [s.id, [{ status: 'good' as const, signer: ['alice@example.test'] }]]));
  const SIGNED = ['Content-Type: multipart/signed; boundary=s; protocol="application/pgp-signature"; micalg=pgp-sha256', '',
    '--s', 'Content-Type: text/plain', '', 'I approve.', '--s', 'Content-Type: application/pgp-signature', '', 'SIG', '--s--', ''];

  test('a signed sibling of a cut body that hides an outer delimiter: no label (the whole message has none)', () => {
    const whole = eml('From: M <m@evil.test>', 'Subject: s', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=o', '',
      '--o', 'Content-Type: multipart/mixed; boundary=r', '', '--r', ...SIGNED,
      '--r', 'Content-Type: application/octet-stream', '', 'HOLEdata', '--o', 'Content-Type: text/plain', '', 'hidden text', 'ENDHOLE', '--r--', '', '--o--', '');
    const c = withHole(whole, 'octet-stream\r\n\r\n', '\r\n--r--');
    const m = mime(c.raw, { holes: c.holes });
    expect(m.cut).toBe('valid');
    expect(m.steps.every((x) => x.incomplete)).toBe(true);
    const v = mime(c.raw, { holes: c.holes, verdicts: good(m) });
    expect(v.parts.map((p) => p.protection.signed)).not.toContain('good');
    expect(v.summary.signed).toBe('none');
    const w = mime(enc(whole), { verdicts: good(mime(enc(whole))) });
    expect(w.summary.signed).toBe('none');
  });

  test('a signed part that is epilogue in the whole message (a hidden close delimiter): pending, never good', () => {
    const whole = eml('From: M <m@evil.test>', 'Subject: s', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=o', '',
      '--o', 'Content-Type: application/octet-stream', '', 'HOLEdata', '--o--', 'junk', '--o', ...SIGNED, '--o--', '');
    const c = withHole(whole, 'octet-stream\r\n\r\n', '\r\n--o\r\nContent-Type: multipart/signed');
    const m = mime(c.raw, { holes: c.holes });
    const v = mime(c.raw, { holes: c.holes, verdicts: good(m) });
    expect(v.parts.find((p) => p.type === 'text')!.protection.signed).toBe('pending');
    expect(v.summary.signed).toBe('none');
    expect(() => fetchRef(enc(whole), c.raw, m.attachments[0]!.ref)).toThrow(/starting with `--`/);
  });

  test('an armored text opened in a cut message is an incomplete step: nothing decrypted, reply unchanged', () => {
    const whole = eml('From: M <m@evil.test>', 'Reply-To: leak@evil.test', 'Subject: s', 'MIME-Version: 1.0', ...multipart('multipart/mixed', 'o',
      ['Content-Type: text/plain', '', '-----BEGIN PGP MESSAGE-----', '', 'hQEMA', '=abcd', '-----END PGP MESSAGE-----'],
      ['Content-Type: application/pdf', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment', '', ...base64Lines(3000)]));
    const c = cut(enc(whole), { over: 100 });
    const first = mime(c.raw, { holes: c.holes });
    const id = (first.parts[0] as Part & { type: 'encrypted' }).step;
    expect(first.parts[0]).toMatchObject({ type: 'encrypted', reason: 'not-root' });
    const m = mime(c.raw, { holes: c.holes, open: [id], decrypted: { [id]: { status: 'ok', plaintext: enc('secret'), integrity: true } } });
    expect(m.parts[0]).toMatchObject({ type: 'encrypted', reason: 'incomplete', step: '1.1#cut' });
    expect(m.steps).toEqual([expect.objectContaining({ kind: 'decrypt', incomplete: true, id: '1.1#cut' })]);
    expect(m.parts.some((p) => p.type === 'text' && p.text.includes('secret'))).toBe(false);
    expect(m.reply).toEqual(first.reply);
  });

  test('past the step limit, an opened part in a cut message is over-limit, as in the whole message', () => {
    const enc1 = (i: number) => ['Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="e' + i + '"', '',
      `--e${i}`, 'Content-Type: application/pgp-encrypted', '', 'Version: 1', `--e${i}`, 'Content-Type: application/octet-stream', '',
      '-----BEGIN PGP MESSAGE-----', '', `hQ${i}`, '-----END PGP MESSAGE-----', `--e${i}--`];
    const whole = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', ...Array.from({ length: 18 }, (_, i) => enc1(i)), pdf(200_000))));
    const ids = mime(whole).parts.map((p) => (p as Part & { type: 'encrypted' }).step);
    const w = mime(whole, { open: ids });
    const c = cut(whole);
    const m = mime(c.raw, { holes: c.holes, open: ids });
    expect(m.steps).toHaveLength(16);
    expect(m.steps.every((x) => x.incomplete)).toBe(true);
    expect(m.parts.map((p) => (p as Part & { type: 'encrypted' }).reason).slice(16)).toEqual(['over-limit', 'over-limit']);
    expect(w.parts.map((p) => (p as Part & { type: 'encrypted' }).reason).slice(16)).toEqual(['over-limit', 'over-limit']);
    expect(m.problems.filter((p) => p.code === 'limit')).toEqual(w.problems.filter((p) => p.code === 'limit'));
  });

  test('an invalid cut marks no Ref', () => {
    const whole = eml('From: a@a.test', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=o', '', '--o', 'Content-Type: application/pdf', '', 'AAAA-', '-o--', 'more', '--o--', '');
    const a = whole.indexOf('-\r\n-o--') + 1;
    const m = mime(enc(whole.slice(0, a) + whole.slice(a + 2)), { holes: [{ start: a, end: a + 2, size: 2 }] });
    expect(m.cut).toBe('invalid');
    for (const x of m.attachments) expect(x.ref.missing).toBeUndefined();
  });
});

describe('more shapes', () => {
  test('a bare-LF message: cut, read and fetched as the whole', () => {
    const s = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', TEXT, pdf(200_000))).replaceAll('\r\n', '\n'));
    const c = cut(s);
    expect(c.holes).toHaveLength(1);
    const m = mime(c.raw, { holes: c.holes }), full = mime(s);
    expect(m.cut).toBe('valid');
    expect(m.parts).toEqual(full.parts);
    expect(fetchRef(s, c.raw, m.attachments[0]!.ref)).toEqual(refBytes(s, full.attachments[0]!.ref));
  });

  test('two holes in one Ref: a forwarded message with two PDFs', () => {
    const inner = [...HEAD, ...multipart('multipart/mixed', 'in', TEXT, pdf(100_000, 'a.pdf'), pdf(150_000, 'b.pdf'))];
    const s = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', TEXT, ['Content-Type: message/rfc822', 'Content-Disposition: attachment', '', ...inner])));
    const c = cut(s);
    expect(c.holes).toHaveLength(2);
    const m = mime(c.raw, { holes: c.holes });
    const a = m.attachments.find((x) => x.kind === 'message')!;
    expect(a.ref.missing!.gaps).toHaveLength(2);
    expect(fetchRef(s, c.raw, a.ref)).toEqual(refBytes(s, mime(s).attachments.find((x) => x.kind === 'message')!.ref));
  });

  test('a message that is one leaf: its body is cut', () => {
    const s = enc(eml(...HEAD, ...pdf(200_000)));
    const c = cut(s);
    const m = mime(c.raw, { holes: c.holes });
    expect(m.cut).toBe('valid');
    expect(m.attachments[0]!.size).toBe(200_000);
    expect(fetchRef(s, c.raw, m.attachments[0]!.ref)).toEqual(refBytes(s, mime(s).attachments[0]!.ref));
  });

  test('a non-root encrypted part with a cut ciphertext: incomplete, no step', () => {
    const exchange = ['Content-Type: multipart/mixed; boundary="x"', '', '--x', 'Content-Type: application/pgp-encrypted', '', 'Version: 1',
      '--x', 'Content-Type: application/octet-stream; name="encrypted.asc"', 'Content-Transfer-Encoding: base64', '', ...base64Lines(200_000), '--x--'];
    const s = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', TEXT, exchange)));
    const c = cut(s);
    const m = mime(c.raw, { holes: c.holes });
    expect(m.steps).toEqual([]);
    expect(m.parts[1]).toMatchObject({ type: 'encrypted', reason: 'incomplete' });
  });

  test('a decrypt result for an incomplete step is stale', () => {
    const s = enc(eml(...HEAD, ...multipart('multipart/mixed', 'x',
      ['Content-Type: application/pgp-encrypted', '', 'Version: 1'],
      ['Content-Type: application/octet-stream', 'Content-Transfer-Encoding: base64', '', ...base64Lines(200_000)])));
    const c = cut(s, { rootCiphertext: true });
    const m = mime(c.raw, { holes: c.holes, decrypted: { '1#cut': { status: 'ok', plaintext: enc(eml('Content-Type: text/plain', '', 'secret')), integrity: true } } });
    expect(m.steps[0]!.state).toBe('pending');
    expect(m.parts[0]).toMatchObject({ type: 'encrypted', reason: 'incomplete' });
    expect(m.problems.map((p) => p.code)).toContain('stale-result');
  });
});

describe('the cache', () => {
  test('holes are compared by value: a new array with the same holes is the message kept', () => {
    const whole = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', TEXT, pdf(200_000))));
    const c = cut(whole);
    const a = mime(c.raw, { holes: c.holes });
    expect(mime(c.raw, { holes: c.holes.map((h) => ({ ...h })) })).toBe(a);
    expect(mime(c.raw)).not.toBe(a);
    expect(mime(c.raw).cut).toBe(null);
    // without the holes, the cut input reads as a whole message with an empty attachment
    expect(mime(c.raw).attachments[0]!.size).toBe(0);
  });

  test('the message is frozen, Refs and missing included', () => {
    const whole = enc(eml(...HEAD, ...multipart('multipart/mixed', 'b', TEXT, pdf(200_000))));
    const c = cut(whole);
    const a: Attachment = mime(c.raw, { holes: c.holes }).attachments[0]!;
    expect(Object.isFrozen(a.ref.missing)).toBe(true);
    expect(Object.isFrozen(a.ref.missing!.gaps[0])).toBe(true);
  });
});
