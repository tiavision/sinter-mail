// OpenPGP structure (docs/proposals/sinter-mail-mime.md, sections 5 to 7, wave 3): steps, the app's results,
// protected headers, protection labels and the summary, with real keys and messages from openpgp.js. Each test runs
// section 1's action recipe (test/mime-crypto-kit.ts) the way an app would.
import { beforeAll, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mime } from '../sinter/mime.js';
import { bytes } from '../sinter/bytes.js';
import { stepDigest, verifyDigest } from '../sinter/mime/sha256.js';
import type { Message, Part, Step } from '../sinter/mime/types.js';
import {
  addrs, App, clearsign, codes, crlf, detach, eml, encrypt, key, multipart, pgpMime, pgpSigned, read, texts, unlock, utf8,
  type Keys,
} from './mime-crypto-kit.js';

let alice: Keys, bob: Keys, mallory: Keys, app: App;
beforeAll(async () => {
  [alice, bob, mallory] = await Promise.all([key('Alice', 'alice@example.test'), key('Bob', 'bob@example.test'), key('Mallory', 'mallory@evil.test')]);
  app = new App(bob, [alice, bob, mallory]);
});

const OUTER = ['From: Alice <alice@example.test>', 'To: bob@example.test', 'Subject: ...', 'Date: Tue, 24 Nov 2026 09:30:00 +0100', 'Message-ID: <m1@example.test>'];
const ALL_OUTER = { subject: 'outer', from: 'outer', sender: 'outer', replyTo: 'outer', to: 'outer', cc: 'outer', date: 'outer', messageId: 'outer', inReplyTo: 'outer', references: 'outer' };
const text = (m: Message, i = 0) => m.parts[i] as Part & { type: 'text' };
const step = (m: Message, kind: Step['kind'], i = 0) => m.steps.filter((s) => s.kind === kind)[i]!;

describe('PGP/MIME encrypted at the root', () => {
  test('a decrypt step bound to the ciphertext; its plaintext shown, labelled encrypted; nothing signed', async () => {
    const raw = pgpMime(OUTER, await encrypt(crlf('Content-Type: text/plain; charset=utf-8\n\nSecret body\n'), bob));
    const pending = mime(raw);
    const s = pending.steps[0] as Step & { kind: 'decrypt' };
    expect(pending.steps).toMatchObject([{ kind: 'decrypt', part: '1', state: 'pending', armored: true }]);
    expect(s.id).toBe(`1#${stepDigest(bytes(raw, s.ciphertext))}`);
    expect(pending.parts).toMatchObject([{ id: '1', type: 'encrypted', reason: 'pending', step: s.id, protection: { encrypted: false, signed: null } }]);
    expect(pending.summary).toEqual({ encrypted: 'none', signed: 'none', from: null });
    const m = await read(raw, app);
    expect(m.steps).toMatchObject([{ id: s.id, state: 'done' }]);
    expect(m.parts).toEqual([{ id: `${s.id}/1`, contentType: 'text/plain', protection: { encrypted: true, signed: null, step: s.id }, type: 'text', text: 'Secret body\r\n', flowed: false, delsp: false }]);
    expect(m.summary).toEqual({ encrypted: 'all', signed: 'none', from: 'unknown' });
    expect([m.headers.subject, m.sources, m.confidential, m.problems]).toEqual(['...', ALL_OUTER, [], []]);
    // mail.bytes reads inside the payload
    const r = await unlock(raw, app);
    expect(new TextDecoder().decode(bytes(raw, { source: s.id, start: 0, end: 12, encoding: 'identity' }, r))).toBe('Content-Type');
  });

  test('sign+encrypt with hp="cipher": the whole set, From signed, HP-Outer confidentiality, legacy display dropped', async () => {
    const payload = crlf(['Content-Type: text/plain; charset=utf-8; hp="cipher"; hp-legacy-display="1"', 'From: Alice <alice@example.test>',
      'To: bob@example.test', 'Subject: The real subject', 'Date: Tue, 24 Nov 2026 09:30:00 +0100', 'Message-ID: <m1@example.test>',
      'HP-Outer: From: Alice <alice@example.test>', 'HP-Outer: To: bob@example.test', 'HP-Outer: Subject: ...',
      'HP-Outer: Date: Tue, 24 Nov 2026 09:30:00 +0100', 'HP-Outer: Message-ID: <m1@example.test>', '',
      'Subject: The real subject', '', 'Hello Bob', ''].join('\n'));
    const m = await read(pgpMime([...OUTER, 'Reply-To: outer@evil.test'], await encrypt(payload, bob, alice)), app);
    const id = m.steps[0]!.id;
    expect(texts(m)).toEqual(['Hello Bob\r\n']);
    expect(m.parts[0]!.protection).toEqual({ encrypted: true, signed: 'good', step: id, signer: ['alice@example.test'] });
    expect(m.headers.subject).toBe('The real subject');
    expect(m.outer.subject).toBe('...');
    expect(addrs(m.headers.from)).toEqual(['alice@example.test']);
    // hp: the payload has no Reply-To, so none is shown (not the outer one)
    expect(m.headers.replyTo).toEqual([]);
    expect(m.sources).toEqual({ ...ALL_OUTER, subject: 'protected', from: 'protected', sender: 'protected', replyTo: 'protected', to: 'protected',
      cc: 'protected', date: 'protected', messageId: 'protected', inReplyTo: 'protected', references: 'protected' });
    expect(addrs(m.reply)).toEqual(['alice@example.test']);
    expect(m.confidential).toEqual(['subject']);
    expect(m.summary).toEqual({ encrypted: 'all', signed: 'all', from: 'matches' });
    expect(m.problems).toEqual([]);
  });

  test('encrypt of multipart/signed (v1): a verify step in the payload, field by field, the v1 display part hidden', async () => {
    const signed = crlf(['Content-Type: multipart/mixed; boundary="v1"; protected-headers="v1"', 'From: Alice <alice@example.test>',
      'Subject: Inner subject', '', '--v1', 'Content-Type: text/rfc822-headers; protected-headers="v1"', 'Content-Disposition: inline', '',
      'Subject: Inner subject', '', '--v1', 'Content-Type: text/plain', '', 'Body', '--v1--', ''].join('\n'));
    // the payload's multipart/signed reuses the outer boundary: a second source is checked against its own boundaries only
    const payload = eml('Content-Type: multipart/signed; micalg=pgp-sha512; protocol="application/pgp-signature"; boundary="enc"', '',
      '--enc', signed, '--enc', 'Content-Type: application/pgp-signature', '', await detach(signed, alice), '--enc--', '');
    const raw = pgpMime([...OUTER, 'Reply-To: outer@evil.test'], await encrypt(payload, bob), 'enc');
    const m = await read(raw, app);
    const d = step(m, 'decrypt'), v = step(m, 'verify') as Step & { kind: 'verify' };
    expect(m.steps.map((s) => [s.kind, s.part, s.state])).toEqual([['decrypt', '1', 'done'], ['verify', `${d.id}/1`, 'done']]);
    expect(v.signed.source).toBe(d.id);
    expect(v.id).toBe(`${d.id}/1#${verifyDigest(bytes(raw, v.signed, await unlock(raw, app)), bytes(raw, v.signature, await unlock(raw, app)))}`);
    expect(texts(m)).toEqual(['Body']);
    expect(m.parts[0]).toMatchObject({ id: `${d.id}/1.1.2`, protection: { encrypted: true, signed: 'good', step: v.id, signer: ['alice@example.test'] } });
    expect(m.headers.subject).toBe('Inner subject');
    expect(addrs(m.headers.to)).toEqual(['bob@example.test']);
    // v1: Reply-To only from the payload, which has none
    expect(m.headers.replyTo).toEqual([]);
    expect([m.sources.subject, m.sources.to, m.sources.replyTo, m.sources.from, m.sources.date]).toEqual(['protected', 'outer', 'protected', 'protected', 'outer']);
    expect(m.confidential).toEqual(['subject']);
    expect(m.summary).toEqual({ encrypted: 'all', signed: 'all', from: 'matches' });
    expect(m.problems).toEqual([]);
  });

  test('legacy display in HTML: legacyDisplay true; text/plain without a blank line keeps everything (legacy-display)', async () => {
    const payload = crlf(['Content-Type: multipart/alternative; boundary="a"; hp="cipher"', 'Subject: S', '', '--a',
      'Content-Type: text/plain; hp-legacy-display="1"', '', 'Subject: S', '', 'plain body', '--a',
      'Content-Type: text/html; hp-legacy-display="1"', '', '<div class="header-protection-legacy-display">Subject: S</div><p>html</p>', '--a--', ''].join('\n'));
    const raw = pgpMime(OUTER, await encrypt(payload, bob));
    const h = await read(raw, app);
    expect(h.parts).toMatchObject([{ type: 'html', legacyDisplay: true }]);
    expect(texts(await read(raw, app, [], { prefer: 'text' }))).toEqual(['plain body']);
    const none = await read(pgpMime(OUTER, await encrypt(crlf('Content-Type: text/plain; hp="cipher"; hp-legacy-display="1"\n\nno blank line here'), bob)), app);
    expect(texts(none)).toEqual(['no blank line here']);
    expect(none.problems).toMatchObject([{ code: 'legacy-display', blocking: false }]);
    // not in a signed-only message, and not without hp
    const nohp = await read(pgpMime(OUTER, await encrypt(crlf('Content-Type: text/plain; hp-legacy-display="1"\n\nSubject: x\n\nbody'), bob)), app);
    expect(texts(nohp)).toEqual(['Subject: x\r\n\r\nbody']);
  });

  test('hp="clear" on an encrypted payload: headers apply, nothing confidential; RFC 8551 message/rfc822 shown nested, not applied', async () => {
    const clear = await read(pgpMime(OUTER, await encrypt(crlf('Content-Type: text/plain; hp="clear"\nSubject: Inner\n\nx'), bob)), app);
    expect([clear.headers.subject, clear.confidential]).toEqual(['Inner', []]);
    const wrapped = await read(pgpMime(OUTER, await encrypt(crlf('Content-Type: message/rfc822\n\nSubject: Wrapped\nFrom: alice@example.test\n\nbody'), bob)), app);
    expect(wrapped.parts).toMatchObject([{ type: 'message', protection: { encrypted: true } }]);
    expect([wrapped.headers.subject, wrapped.sources.subject]).toEqual(['...', 'outer']);
    expect((wrapped.parts[0] as Part & { type: 'message' }).message.headers.subject).toBe('Wrapped');
  });

  test("Exchange's rewrite is read as multipart/encrypted (exchange-shape)", async () => {
    const armor = await encrypt(crlf('Content-Type: text/plain\n\nvia Exchange'), bob);
    const raw = eml(...OUTER, 'MIME-Version: 1.0', ...multipart('multipart/mixed', '_003_', ['Content-Type: text/plain; charset="us-ascii"', '', ''],
      ['Content-Type: application/pgp-encrypted', 'Content-Transfer-Encoding: base64', '', btoa('Version: 1\r\n')],
      ['Content-Type: application/octet-stream; name="encrypted.asc"', 'Content-Transfer-Encoding: base64', '', btoa(armor).replace(/.{76}/g, '$&\r\n')]));
    const m = await read(raw, app);
    expect(m.steps).toMatchObject([{ kind: 'decrypt', part: '1', state: 'done', ciphertext: { encoding: 'base64' } }]);
    expect(texts(m)).toEqual(['via Exchange']);
    expect(m.problems).toEqual([{ code: 'exchange-shape', part: '1', blocking: false }]);
    expect(m.summary.encrypted).toBe('all');
  });

  test('encrypted twice: one more decrypt step, at most once', async () => {
    const leaf = crlf('Content-Type: text/plain\n\ninnermost');
    const entity = async (armor: string) => eml(...multipart('multipart/encrypted; protocol="application/pgp-encrypted"', 'x',
      ['Content-Type: application/pgp-encrypted', '', 'Version: 1'], ['Content-Type: application/octet-stream', '', armor]));
    const twice = pgpMime(OUTER, await encrypt(await entity(await encrypt(leaf, bob)), bob));
    const m = await read(twice, app);
    expect(m.steps.map((s) => [s.kind, s.part, s.state])).toEqual([['decrypt', '1', 'done'], ['decrypt', `${m.steps[0]!.id}/1`, 'done']]);
    expect(texts(m)).toEqual(['innermost']);
    expect(m.parts[0]!.protection).toEqual({ encrypted: true, signed: null, step: m.steps[1]!.id });
    expect(m.summary.encrypted).toBe('all');
    const thrice = pgpMime(OUTER, await encrypt(await entity(await encrypt(await entity(await encrypt(leaf, bob)), bob)), bob));
    const t = await read(thrice, app);
    expect(t.steps.length).toBe(2);
    expect(t.parts).toMatchObject([{ type: 'encrypted', reason: 'not-root', protection: { encrypted: true } }]);
  });

  test('sign over encrypt: a verify step for the root and a decrypt step for its first part; the signature covers the payload', async () => {
    const enc = eml(...multipart('multipart/encrypted; protocol="application/pgp-encrypted"', 'e',
      ['Content-Type: application/pgp-encrypted', '', 'Version: 1'], ['Content-Type: application/octet-stream', '', await encrypt(crlf('Content-Type: text/plain\n\nsigned and sealed'), bob)])).replace(/\r\n$/, '');
    const m = await read(pgpSigned(OUTER, enc, await detach(enc, alice)), app);
    expect(m.steps.map((s) => [s.kind, s.part, s.state])).toEqual([['verify', '1', 'done'], ['decrypt', '1.1', 'done']]);
    expect(m.parts[0]).toMatchObject({ type: 'text', text: 'signed and sealed', protection: { encrypted: true, signed: 'good', step: m.steps[0]!.id } });
    expect(m.summary).toEqual({ encrypted: 'all', signed: 'all', from: 'matches' });
    // a blocking problem in the payload is below the signed part: no verify step, and the payload labelled by its decryption
    const bad = eml(...multipart('multipart/encrypted; protocol="application/pgp-encrypted"', 'e',
      ['Content-Type: application/pgp-encrypted', '', 'Version: 1'], ['Content-Type: application/octet-stream', '', await encrypt(crlf('Content-Type: text/plain\nContent-Type: text/html\n\nx'), bob)])).replace(/\r\n$/, '');
    const b = await read(pgpSigned(OUTER, bad, await detach(bad, alice)), app);
    expect(b.steps.map((s) => s.kind)).toEqual(['decrypt']);
    expect(b.parts[0]!.protection).toEqual({ encrypted: true, signed: null, step: b.steps[0]!.id });
    expect(b.problems).toContainEqual({ code: 'duplicate-field', part: `${b.steps[0]!.id}/1`, blocking: true });
  });
});

describe('the app\'s results', () => {
  const plainPayload = crlf('Content-Type: text/plain\n\nx');

  test('a status other than ok fails without an integrity problem; ok without integrity fails with one; ok without plaintext fails', async () => {
    const raw = pgpMime(OUTER, await encrypt(plainPayload, bob));
    const id = mime(raw).steps[0]!.id;
    const failed = mime(raw, { decrypted: { [id]: { status: 'no-key', integrity: false } } });
    expect([failed.steps[0]!.state, failed.parts[0]]).toMatchObject(['failed', { type: 'encrypted', reason: 'failed' }]);
    expect(failed.problems).toEqual([]);
    const noIntegrity = mime(raw, { decrypted: { [id]: { status: 'ok', integrity: false, plaintext: utf8(plainPayload) } } });
    expect([noIntegrity.steps[0]!.state, noIntegrity.parts.map((p) => p.type)]).toEqual(['failed', ['encrypted']]);
    expect(noIntegrity.problems).toEqual([{ code: 'integrity', part: '1', blocking: true }]);
    expect(mime(raw, { decrypted: { [id]: { status: 'ok', integrity: true } } }).steps[0]!.state).toBe('failed');
  });

  test('a plaintext over 64 MiB is over the limit', async () => {
    const raw = pgpMime(OUTER, await encrypt(plainPayload, bob));
    const id = mime(raw).steps[0]!.id;
    const m = mime(raw, { decrypted: { [id]: { status: 'ok', integrity: true, plaintext: new Uint8Array(64 * 1024 * 1024 + 1) } } });
    expect([m.steps[0]!.state, m.parts[0]]).toMatchObject(['failed', { type: 'encrypted', reason: 'over-limit' }]);
    expect(codes(m)).toEqual(['limit']);
  });

  test('several verdicts: good if any is (signer the union), else bad > revoked > expired > no-key > unsupported; none is unsupported', () => {
    const raw = eml(...OUTER, ...multipart('multipart/signed; protocol="application/pgp-signature"', 's', ['Content-Type: text/plain', '', 'x'],
      ['Content-Type: application/pgp-signature', '', 'sig']));
    const id = mime(raw).steps[0]!.id;
    const label = (vs: never[]) => mime(raw, { verdicts: { [id]: vs } }).parts[0]!.protection;
    expect(label([{ status: 'bad' }, { status: 'good', signer: ['a@x.test'] }, { status: 'good', signer: ['b@x.test', 'a@x.test'] }] as never[]))
      .toEqual({ encrypted: false, signed: 'good', step: id, signer: ['a@x.test', 'b@x.test'] });
    expect(label([{ status: 'no-key' }, { status: 'expired' }] as never[]).signed).toBe('expired');
    expect(label([{ status: 'unsupported' }, { status: 'revoked' }, { status: 'bad' }] as never[]).signed).toBe('bad');
    expect(label([{ status: 'unsupported' }, { status: 'no-key' }] as never[]).signed).toBe('no-key');
    expect(label([]).signed).toBe('unsupported');
    expect(mime(raw, { verdicts: { [id]: [] } }).steps[0]!.state).toBe('done');
  });

  test('signatures inside the ciphertext by an unknown key: no-key; the summary claims nothing', async () => {
    const stranger = await key('S', 's@x.test');
    const m = await read(pgpMime(OUTER, await encrypt(plainPayload, bob, stranger)), app);
    expect(m.parts[0]!.protection).toEqual({ encrypted: true, signed: 'no-key', step: m.steps[0]!.id });
    expect(m.summary).toEqual({ encrypted: 'all', signed: 'none', from: 'unknown' });
  });
});

describe('PGP/MIME signed', () => {
  const signedPart = crlf(['Content-Type: text/plain; charset=utf-8; hp="clear"', 'From: Alice <alice@example.test>', 'To: bob@example.test',
    'Subject: Signed subject', '', 'Signed body'].join('\n'));

  test('signed only, hp="clear": outer headers until the verdict is good; then the payload\'s, From matching', async () => {
    const raw = pgpSigned([...OUTER.slice(0, 2), 'Subject: Outer subject'], signedPart, await detach(signedPart, alice));
    const pending = mime(raw);
    const v = pending.steps[0] as Step & { kind: 'verify' };
    expect(pending.steps).toMatchObject([{ kind: 'verify', part: '1', state: 'pending', micalg: 'pgp-sha512', signed: { source: 'input', encoding: 'identity' } }]);
    expect(new TextDecoder().decode(bytes(raw, v.signed))).toBe(signedPart);
    expect([pending.headers.subject, pending.sources, pending.summary]).toEqual(['Outer subject', ALL_OUTER, { encrypted: 'none', signed: 'none', from: 'unknown' }]);
    const m = await read(raw, app);
    expect(m.parts).toMatchObject([{ id: '1.1', text: 'Signed body', protection: { encrypted: false, signed: 'good', step: v.id, signer: ['alice@example.test'] } }]);
    expect([m.headers.subject, m.sources.subject, m.sources.from, m.sources.to, m.confidential]).toEqual(['Signed subject', 'protected', 'protected', 'protected', []]);
    expect(m.summary).toEqual({ encrypted: 'none', signed: 'all', from: 'matches' });
    // a bad verdict: the outer headers, nothing signed
    const bad = mime(raw, { verdicts: { [v.id]: [{ status: 'bad' }] } });
    expect([bad.headers.subject, bad.parts[0]!.protection.signed, bad.summary]).toEqual(['Outer subject', 'bad', { encrypted: 'none', signed: 'none', from: 'unknown' }]);
  });

  test('signed by a key not bound to the From: some, unknown; bound to the protected From: matches it; to the outer one only: differs', async () => {
    const raw = pgpSigned(OUTER, signedPart, await detach(signedPart, mallory));
    const m = await read(raw, app);
    expect([m.parts[0]!.protection.signed, m.summary]).toEqual(['good', { encrypted: 'none', signed: 'some', from: 'unknown' }]);
    expect(addrs(m.headers.from)).toEqual(['alice@example.test']);
    const asMallory = crlf(signedPart.replace('From: Alice <alice@example.test>', 'From: Mallory <mallory@evil.test>'));
    const d = await read(pgpSigned(OUTER, asMallory, await detach(asMallory, mallory)), app);
    // row 3: the signer includes the From to show, the protected one
    expect(d.summary).toEqual({ encrypted: 'none', signed: 'all', from: 'matches' });
    expect(addrs(d.headers.from)).toEqual(['mallory@evil.test']);
    // the signer matches only the outer From: differs (Settled for implementation)
    const e = await read(pgpSigned(OUTER, asMallory, await detach(asMallory, alice)), app);
    expect([e.summary.from, addrs(e.headers.from), e.sources.from]).toEqual(['differs', ['alice@example.test'], 'outer']);
  });

  test('bare LF line ends: the signed Ref is canonical (canonicalized), and verifies over CRLF', async () => {
    const part = 'Content-Type: text/plain\r\n\r\nline one\r\nline two';
    const raw = pgpSigned(OUTER, part, await detach(part, alice)).replace(/\r\n/g, '\n');
    const pending = mime(raw);
    expect(pending.steps).toMatchObject([{ kind: 'verify', signed: { canonical: true } }]);
    expect(codes(pending)).toEqual(['canonicalized']);
    const m = await read(raw, app);
    expect([m.parts[0]!.protection.signed, m.summary.signed]).toEqual(['good', 'all']);
  });

  test('anywhere shown: in multipart/mixed with a footer (some); not in a nested message or an unchosen alternative', async () => {
    const part = 'Content-Type: text/plain\r\n\r\nsigned';
    const signed = eml(...multipart('multipart/signed; micalg=pgp-sha512; protocol="application/pgp-signature"', 's', [part],
      ['Content-Type: application/pgp-signature', '', await detach(part, alice)])).replace(/\r\n$/, '');
    const list = await read(eml(...OUTER, ...multipart('multipart/mixed', 'm', [signed], ['Content-Type: text/plain', '', 'list footer'])), app);
    expect(list.steps).toMatchObject([{ kind: 'verify', part: '1.1', state: 'done' }]);
    expect(list.parts.map((p) => [texts({ ...list, parts: [p] } as Message)[0], p.protection.signed])).toEqual([['signed', 'good'], ['list footer', null]]);
    expect(list.summary).toEqual({ encrypted: 'none', signed: 'some', from: 'unknown' });
    const nested = mime(eml(...OUTER, ...multipart('multipart/mixed', 'm', ['Content-Type: message/rfc822', '', 'Subject: fwd', ...signed.split('\r\n')])));
    expect(nested.steps).toEqual([]);
    const unchosen = mime(eml(...OUTER, ...multipart('multipart/alternative', 'a', [signed], ['Content-Type: text/html', '', '<p>h</p>'])));
    expect([unchosen.steps, texts(unchosen)]).toEqual([[], ['<p>h</p>']]);
  });
});

describe('inline PGP', () => {
  test('a cleartext-signed block splits the part: text before and after unsigned, the signed text dash-unescaped and trimmed', async () => {
    const block = await clearsign('Signed line\n-dash line\ntrailing   ', alice);
    expect(block).toContain('- -dash line');
    const raw = eml(...OUTER, 'Content-Type: text/plain; charset=utf-8; format=flowed', '', 'Hi, see below.', block, 'Footer');
    const pending = mime(raw);
    const s = pending.steps[0] as Step & { kind: 'verify-cleartext' };
    expect(pending.steps).toMatchObject([{ kind: 'verify-cleartext', part: '1:2', charset: 'utf-8', block: { slice: [expect.any(Number), expect.any(Number)] } }]);
    expect(s.id).toBe(`1:2#${stepDigest(bytes(raw, s.block))}`);
    expect(new TextDecoder().decode(bytes(raw, s.block))).toBe(block);
    const m = await read(raw, app);
    expect(m.parts).toEqual([
      { id: '1:1', contentType: 'text/plain', protection: { encrypted: false, signed: null }, type: 'text', text: 'Hi, see below.\r\n', flowed: true, delsp: false },
      { id: '1:2', contentType: 'text/plain', protection: { encrypted: false, signed: 'good', step: s.id, signer: ['alice@example.test'] }, type: 'text',
        text: 'Signed line\r\n-dash line\r\ntrailing', flowed: false, delsp: false },
      { id: '1:3', contentType: 'text/plain', protection: { encrypted: false, signed: null }, type: 'text', text: 'Footer', flowed: true, delsp: false },
    ]);
    expect(m.summary).toEqual({ encrypted: 'none', signed: 'some', from: 'unknown' });
    expect(m.problems).toEqual([]);
  });

  test('a cleartext block inside a base64 text/plain: Ref.slice into the decoded body', async () => {
    const block = await clearsign('in base64', alice);
    const raw = eml(...OUTER, 'Content-Type: text/plain', 'Content-Transfer-Encoding: base64', '', btoa('before\r\n' + block + '\r\n'));
    const s = mime(raw).steps[0] as Step & { kind: 'verify-cleartext' };
    expect(s.block).toMatchObject({ encoding: 'base64', slice: [8, 8 + block.length] });
    expect((await read(raw, app)).parts[1]!.protection.signed).toBe('good');
  });

  test('an armored message as the root\'s only part shown: a decrypt step; its plaintext a text body, signed inside', async () => {
    const raw = eml(...OUTER, 'Content-Type: text/plain', '', '', await encrypt('Inline secret\n', bob, alice), '');
    const pending = mime(raw);
    expect(pending.steps).toMatchObject([{ kind: 'decrypt', part: '1', armored: true, ciphertext: { encoding: 'identity' } }]);
    expect(pending.parts).toMatchObject([{ type: 'encrypted', reason: 'pending' }]);
    const m = await read(raw, app);
    const id = m.steps[0]!.id;
    expect(m.parts).toEqual([{ id: `${id}/1`, contentType: 'text/plain', protection: { encrypted: true, signed: 'good', step: id, signer: ['alice@example.test'] },
      type: 'text', text: 'Inline secret\n', flowed: false, delsp: false }]);
    expect(m.summary).toEqual({ encrypted: 'all', signed: 'all', from: 'matches' });
  });

  test('the chosen text alternative wholly armored: a decrypt step; the HTML alternative never one', async () => {
    const armor = await encrypt('from the alternative', bob);
    const raw = eml(...OUTER, ...multipart('multipart/alternative', 'a', ['Content-Type: text/plain', '', armor], ['Content-Type: text/html', '', `<pre>${armor}</pre>`]));
    const m = await read(raw, app);
    expect(m.steps).toMatchObject([{ kind: 'decrypt', part: '1.1', state: 'done' }]);
    expect(texts(m)).toEqual(['from the alternative']);
  });

  test('armor with text around it, or among several parts: not-root, opened with open, in place', async () => {
    const armor = (await encrypt('opened text', bob)).replace(/\r\n$/, '');
    const raw = eml(...OUTER, 'Content-Type: text/plain', '', armor, '-- ', 'List footer');
    const m = mime(raw);
    const p = m.parts[0] as Part & { type: 'encrypted' };
    expect(m.parts).toMatchObject([{ id: '1:1', type: 'encrypted', reason: 'not-root', ref: { slice: [0, armor.length] } }, { id: '1:2', type: 'text', text: '-- \r\nList footer' }]);
    expect(p.step).toMatch(/^1:1#[0-9a-f]{32}$/);
    expect(m.steps).toEqual([]);
    const o = await read(raw, app, [p.step]);
    expect(o.steps).toMatchObject([{ id: p.step, kind: 'decrypt', part: '1:1', state: 'done' }]);
    expect(o.parts).toMatchObject([{ id: `${p.step}/1`, text: 'opened text', protection: { encrypted: true, opened: true } }, { text: '-- \r\nList footer', protection: { encrypted: false } }]);
    expect(o.summary).toEqual({ encrypted: 'some', signed: 'none', from: 'unknown' });
    const two = mime(eml(...OUTER, ...multipart('multipart/mixed', 'm', ['Content-Type: text/plain', '', armor], ['Content-Type: text/plain', '', 'second'])));
    expect([two.steps, two.parts[0]]).toMatchObject([[], { id: '1.1', type: 'encrypted', reason: 'not-root' }]);
  });

  test('at most 4 blocks: a fifth is text; inside HTML never a step', async () => {
    const fake = (n: number) => ['-----BEGIN PGP SIGNED MESSAGE-----', 'Hash: SHA256', '', `block ${n}`, '-----BEGIN PGP SIGNATURE-----', '', 'iQ', '-----END PGP SIGNATURE-----'];
    const m = mime(eml(...OUTER, 'Content-Type: text/plain', '', ...[1, 2, 3, 4, 5].flatMap(fake)));
    expect(m.steps.map((s) => s.part)).toEqual(['1:1', '1:2', '1:3', '1:4']);
    expect(texts(m).slice(0, 4)).toEqual(['block 1', 'block 2', 'block 3', 'block 4']);
    expect(texts(m)[4]).toMatch(/^-----BEGIN PGP SIGNED MESSAGE-----\r\nHash: SHA256\r\n\r\nblock 5/);
    expect(mime(eml(...OUTER, 'Content-Type: text/html', '', ...fake(1))).steps).toEqual([]);
  });
});

describe('opened parts and nested messages', () => {
  test('a PGP/MIME part not at the root: not-root with its would-be id; opened, shown in place, no protected headers, some', async () => {
    const enc = eml(...multipart('multipart/encrypted; protocol="application/pgp-encrypted"', 'e',
      ['Content-Type: application/pgp-encrypted', '', 'Version: 1'],
      ['Content-Type: application/octet-stream', '', await encrypt(crlf('Content-Type: text/plain; hp="cipher"\nSubject: hidden\n\ninside'), bob)]));
    const raw = eml(...OUTER, ...multipart('multipart/mixed', 'm', ['Content-Type: text/plain', '', 'intro'], enc.split('\r\n')));
    const m = mime(raw);
    const p = m.parts[1] as Part & { type: 'encrypted' };
    expect(p).toMatchObject({ id: '1.2', type: 'encrypted', reason: 'not-root', contentType: 'multipart/encrypted' });
    expect(p.step).toMatch(/^1\.2#[0-9a-f]{32}$/);
    expect(m.steps).toEqual([]);
    const pending = mime(raw, { open: [p.step] });
    expect([pending.steps.map((s) => s.state), pending.parts[1]]).toMatchObject([['pending'], { reason: 'pending' }]);
    const o = await read(raw, app, [p.step]);
    expect(texts(o)).toEqual(['intro', 'inside']);
    expect(o.parts[1]!.protection).toEqual({ encrypted: true, opened: true, signed: null, step: p.step });
    expect([o.headers.subject, o.confidential, o.summary]).toEqual(['...', [], { encrypted: 'some', signed: 'none', from: 'unknown' }]);
    expect(o.problems).toEqual([]);
  });

  test('a nested message: no steps of its own; its encrypted part is not-root, opened through the outer message\'s steps', async () => {
    const armor = await encrypt('nested secret', bob);
    const raw = eml(...OUTER, ...multipart('multipart/mixed', 'm', ['Content-Type: text/plain', '', 'fwd'], ['Content-Type: message/rfc822', '', 'Subject: inner', 'Content-Type: text/plain', '', armor]));
    const m = mime(raw);
    const nested = (m.parts[1] as Part & { type: 'message' }).message;
    const p = nested.parts[0] as Part & { type: 'encrypted' };
    expect([nested.steps, m.steps, p.reason, p.id]).toEqual([[], [], 'not-root', '1.2.1']);
    const o = await read(raw, app, [p.step]);
    expect(o.steps).toMatchObject([{ id: p.step, state: 'done' }]);
    expect(texts((o.parts[1] as Part & { type: 'message' }).message)).toEqual(['nested secret']);
  });

  test('.pgp, .gpg and .asc attachments are kind encrypted, not steps; an encrypted unchosen alternative makes no step', () => {
    const m = mime(eml(...OUTER, ...multipart('multipart/mixed', 'm', ['Content-Type: text/plain', '', 'see attached'],
      ['Content-Type: application/octet-stream; name="doc.pdf.pgp"', 'Content-Disposition: attachment; filename="doc.pdf.pgp"', '', 'x'])));
    expect([m.steps, m.attachments.map((a) => a.kind)]).toEqual([[], ['encrypted']]);
    const alt = mime(eml(...OUTER, ...multipart('multipart/alternative', 'a', ['Content-Type: text/html', '', '<p>h</p>'],
      ['Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary=e', '', '--e', 'Content-Type: application/pgp-encrypted', '', 'Version: 1', '--e', 'Content-Type: application/octet-stream', '', 'x', '--e--'])));
    expect(alt.steps).toEqual([]);
  });
});

describe('purity', () => {
  test("the steps' modules fold: sinter's check finds only the allowed globals", async () => {
    const check = new URL('../node_modules/@tiaforge-ui/sinter/dist/fold-check.js', import.meta.url).href;
    const { foldVerdict } = (await import(check)) as { foldVerdict: (file: string, name: string, root: string) => { fold: boolean } };
    const root = fileURLToPath(new URL('..', import.meta.url));
    const at = (f: string) => fileURLToPath(new URL(`../sinter/${f}`, import.meta.url));
    for (const [f, n] of [['mime.ts', 'mime'], ['mime/index.ts', 'read'], ['mime/crypto.ts', 'showEncrypted'], ['mime/crypto.ts', 'showSigned'],
      ['mime/crypto.ts', 'showText'], ['mime/crypto.ts', 'resolveCandidates'], ['mime/steps.ts', 'findBlocks'], ['mime/steps.ts', 'combine'],
      ['mime/hp.ts', 'applyProtected'], ['mime/protect.ts', 'rootMessage']]) {
      expect(foldVerdict(at(f), n, root), `${f} ${n}`).toEqual({ fold: true });
    }
  });

  test('the library never imports openpgp', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = fileURLToPath(new URL('../sinter/mime/', import.meta.url));
    for (const f of readdirSync(dir)) expect(readFileSync(dir + f, 'utf8'), f).not.toMatch(/from '[^']*openpgp/);
  });
});
