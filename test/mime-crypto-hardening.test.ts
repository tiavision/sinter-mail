// Hardening of the OpenPGP structure layer (docs/proposals/sinter-mail-mime.md, sections 5 to 7 and "Settled for
// implementation"): edge cases, each with the outcome the proposal asks for. Cleartext blocks the reader
// and an OpenPGP implementation could read differently; a sole cleartext block never unlocking protected headers;
// one-pass signatures under the blocking rule; withdrawn and blocked steps labelling nothing; the charset in the
// cleartext digest; digests per call; `reply` empty for a payload with neither Reply-To nor From; bounded CPU.
import { beforeAll, describe, expect, test } from 'vitest';
import { mime } from '../sinter/mime.js';
import { bytes } from '../sinter/bytes.js';
import { cleartextDigest, stepDigest } from '../sinter/mime/sha256.js';
import type { Message, Part, Step } from '../sinter/mime/types.js';
import {
  addrs, App, clearsign, codes, crlf, detach, eml, encrypt, key, multipart, pgpMime, pgpSigned, read, texts, unlock, utf8, type Keys,
} from './mime-crypto-kit.js';

let alice: Keys, bob: Keys, mallory: Keys, app: App;
beforeAll(async () => {
  [alice, bob, mallory] = await Promise.all([key('Alice', 'alice@example.test'), key('Bob', 'bob@example.test'), key('Mallory', 'mallory@evil.test')]);
  app = new App(bob, [alice, bob, mallory]);
});

const ALICE = ['From: Alice <alice@example.test>', 'To: bob@example.test', 'Subject: outer'];
const MALLORY = ['From: Mallory <mallory@evil.test>', 'To: bob@example.test', 'Subject: outer'];
const kinds = (m: Message) => m.steps.map((s) => [s.kind, s.state]);
const unsigned = (m: Message) => [...m.parts, ...m.attachments].every((p) => p.protection.signed === null);

/** a block of Alice's whose BEGIN and END SIGNATURE lines start with `prefix`, then an attacker's PS and a fake signature */
async function prefixed(prefix: string): Promise<string[]> {
  const lines = (await clearsign('I owe Bob 5 EUR.', alice)).split('\r\n');
  const iSig = lines.indexOf('-----BEGIN PGP SIGNATURE-----'), iEnd = lines.indexOf('-----END PGP SIGNATURE-----');
  return [...lines.slice(0, iSig), prefix + lines[iSig], ...lines.slice(iSig + 1, iEnd), prefix + lines[iEnd],
    'PS: actually I owe Bob 5000 EUR, wire it today.', '-----BEGIN PGP SIGNATURE-----', '', 'AAAA', '-----END PGP SIGNATURE-----'];
}

describe('finding 1: cleartext blocks read differently by an OpenPGP implementation make no step', () => {
  test('a bare CR before the BEGIN and END SIGNATURE lines: text, armor-headers, nothing signed', async () => {
    const raw = eml(...ALICE, 'Content-Type: text/plain', '', ...await prefixed('\r'));
    const m = await read(raw, app);
    expect(m.steps).toEqual([]);
    expect(codes(m)).toEqual(['armor-headers']);
    expect(m.parts).toHaveLength(1);
    expect(texts(m)[0]).toContain('PS: actually I owe Bob 5000 EUR');
    expect(unsigned(m)).toBe(true);
    expect(m.summary).toEqual({ encrypted: 'none', signed: 'none', from: null });
  });

  test('ESC ( B before them, in iso-2022-jp (not a stateless ASCII superset): text, armor-headers', async () => {
    const raw = eml(...ALICE, 'Content-Type: text/plain; charset=iso-2022-jp', '', ...await prefixed('\x1b(B'));
    const m = await read(raw, app);
    expect(m.steps).toEqual([]);
    expect(codes(m)).toEqual(['armor-headers']);
    expect(unsigned(m)).toBe(true);
    expect(m.summary.signed).toBe('none');
  });

  test('a well-formed block in iso-2022-jp, UTF-16 or UTF-7 makes no step either; in koi8-r it does', async () => {
    const block = await clearsign('Hello Bob', alice);
    for (const cs of ['iso-2022-jp', 'ISO-2022-KR', 'utf-16le', 'utf-16', 'utf-32', 'utf-7']) {
      const m = mime(eml(...ALICE, `Content-Type: text/plain; charset=${cs}`, '', block));
      expect(m.steps, cs).toEqual([]);
      expect(unsigned(m), cs).toBe(true);
      // a block the decoded text still shows (not ISO-2022-KR's one U+FFFD, not UTF-16's other characters) is text
      if (texts(m)[0]!.includes('-----BEGIN PGP SIGNED MESSAGE-----')) expect(codes(m), cs).toContain('armor-headers');
    }
    const koi = await read(eml(...ALICE, 'Content-Type: text/plain; charset=" KOI8-R"', '', block), app);
    expect(koi.steps).toMatchObject([{ kind: 'verify-cleartext', state: 'done', charset: 'koi8-r' }]);
    expect(koi.summary).toEqual({ encrypted: 'none', signed: 'all', from: 'matches' });
  });

  test('a control byte, or a line that reads as an armor line only once trailing whitespace or U+2028 is taken into account', async () => {
    const block = (await clearsign('line one\nline two', alice)).split('\r\n');
    const at = block.indexOf('line two');
    const variants = [
      block.map((l, i) => (i === at ? 'line\x00two' : l)),
      block.map((l, i) => (i === at ? 'line\x0ctwo' : l)),
      block.map((l, i) => (i === at ? 'line two -----BEGIN PGP SIGNATURE-----' : l)),
      block.map((l, i) => (i === at ? '-----BEGIN PGP SIGNATURE----- ' : l)),
    ];
    for (const v of variants) {
      const m = mime(eml(...ALICE, 'Content-Type: text/plain; charset=utf-8', '', ...v));
      expect(m.steps, JSON.stringify(v[at])).toEqual([]);
      expect(codes(m)).toContain('armor-headers');
    }
    // the block as signed is still a step
    const ok = await read(eml(...ALICE, 'Content-Type: text/plain; charset=utf-8', '', ...block), app);
    expect(kinds(ok)).toEqual([['verify-cleartext', 'done']]);
    expect(ok.parts[0]!.protection.signed).toBe('good');
  });
});

describe('finding 2: a sole cleartext block never unlocks protected headers', () => {
  test('a bad multipart/signed around an hp="clear" payload whose body is an old block of Alice: everything outer', async () => {
    const block = await clearsign('Yes, I agree.', alice);
    const part = eml('Content-Type: text/plain; hp="clear"', 'From: Alice <alice@example.test>', 'Reply-To: mallory@evil.test', 'Subject: Re: transfer 5000 EUR', '', block);
    const raw = pgpSigned(ALICE, part, '-----BEGIN PGP SIGNATURE-----\r\n\r\nAAAA\r\n-----END PGP SIGNATURE-----');
    const m = await read(raw, app);
    expect(m.steps.find((s) => s.kind === 'verify')).toMatchObject({ state: 'done' });
    expect(m.headers.subject).toBe('outer');
    expect(m.sources.subject).toBe('outer');
    expect(m.sources.replyTo).toBe('outer');
    expect(addrs(m.reply)).toEqual(['alice@example.test']);
    expect(m.summary).toEqual({ encrypted: 'none', signed: 'some', from: 'unknown' });
    // the block still labels its own part
    expect(m.parts[0]!.protection).toMatchObject({ signed: 'good', signer: ['alice@example.test'] });
  });

  test('an attacker-encrypted v1 payload holding Alice\'s block: headers per the encrypted rules, From not bound', async () => {
    const block = await clearsign('Yes, I agree.', alice);
    const payload = eml('Content-Type: text/plain; protected-headers="v1"', 'From: Alice <alice@example.test>', 'Reply-To: mallory@evil.test', 'Subject: Re: transfer 5000 EUR to account X', '', block);
    const m = await read(pgpMime(MALLORY, await encrypt(payload, bob)), app);
    expect(m.headers.subject).toBe('Re: transfer 5000 EUR to account X');
    expect(m.sources.from).toBe('outer');
    expect(addrs(m.headers.from)).toEqual(['mallory@evil.test']);
    expect(m.summary).toEqual({ encrypted: 'all', signed: 'some', from: 'differs' });
  });

  test('the same with hp="cipher" under Alice\'s outer From: not matches, not all', async () => {
    const block = await clearsign('Yes, I agree.', alice);
    const payload = eml('Content-Type: text/plain; hp="cipher"', 'From: Alice <alice@example.test>', 'Reply-To: mallory@evil.test', 'Subject: Re: transfer 5000 EUR to account X', '', block);
    const m = await read(pgpMime(ALICE, await encrypt(payload, bob)), app);
    expect(m.sources.from).toBe('outer');
    expect(m.summary.from).not.toBe('matches');
    expect(m.summary.signed).not.toBe('all');
    expect(m.summary).toEqual({ encrypted: 'all', signed: 'some', from: 'unknown' });
  });

  test('signed only by Mallory, hp="clear", Alice\'s block inside: protected headers apply by Mallory\'s signature, From not bound', async () => {
    const block = await clearsign('Yes, I agree.', alice);
    const part = eml('Content-Type: text/plain; hp="clear"', 'From: Alice <alice@example.test>', 'Reply-To: mallory@evil.test', 'Subject: Re: transfer 5000 EUR', '', block);
    const m = await read(pgpSigned(ALICE, part, await detach(part, mallory)), app);
    expect(m.sources.subject).toBe('protected');
    expect(m.sources.from).toBe('outer');
    expect(m.summary).toEqual({ encrypted: 'none', signed: 'some', from: 'unknown' });
  });

  test('without a protected headers form, a sole block still counts against the outer From', async () => {
    const block = await clearsign('Yes, I agree.', alice);
    const m = await read(pgpMime(ALICE, await encrypt(eml('Content-Type: text/plain', '', block), bob)), app);
    expect(m.summary).toEqual({ encrypted: 'all', signed: 'all', from: 'matches' });
    const other = await read(pgpMime(MALLORY, await encrypt(eml('Content-Type: text/plain', '', block), bob)), app);
    expect(other.summary).toEqual({ encrypted: 'all', signed: 'some', from: 'unknown' });
  });
});

describe('finding 3: one-pass signatures under the blocking rule', () => {
  test('a blocking problem in the payload (a duplicate Content-Type): signed null, not a root signature', async () => {
    const payload = eml('Content-Type: multipart/mixed; boundary="a"', 'Content-Type: text/plain', '', '--a', 'Content-Type: text/plain', '', 'in multipart', '--a--', '');
    const m = await read(pgpMime(ALICE, await encrypt(payload, bob, alice)), app);
    expect(texts(m)).toEqual(['in multipart']);
    expect(m.parts[0]!.protection).toEqual({ encrypted: true, signed: null, step: m.steps[0]!.id });
    expect(m.summary).toEqual({ encrypted: 'all', signed: 'none', from: 'unknown' });
  });

  test('mid-stream base64 padding in the payload: the same, and base64-junk blocking', async () => {
    const payload = eml('Content-Type: multipart/mixed; boundary="a"', '', '--a', 'Content-Type: text/plain', 'Content-Transfer-Encoding: base64', '', 'aGVsbG8=', 'ZXZpbA==', '--a--', '');
    const m = await read(pgpMime(ALICE, await encrypt(payload, bob, alice)), app);
    expect(texts(m)).toEqual(['helloevil']);
    expect(unsigned(m)).toBe(true);
    expect(m.problems).toContainEqual({ code: 'base64-junk', part: `${m.steps[0]!.id}/1.1`, blocking: true });
    expect(m.summary).toEqual({ encrypted: 'all', signed: 'none', from: 'unknown' });
    // without the padding, the one-pass signature labels and covers the root
    const clean = eml('Content-Type: multipart/mixed; boundary="a"', '', '--a', 'Content-Type: text/plain', 'Content-Transfer-Encoding: base64', '', 'aGVsbG9ldmls', '--a--', '');
    const ok = await read(pgpMime(ALICE, await encrypt(clean, bob, alice)), app);
    expect(ok.summary).toEqual({ encrypted: 'all', signed: 'all', from: 'matches' });
  });
});

describe('finding 4: bounded CPU', () => {
  test('3 MB of line breaks in application/pgp-encrypted at depth 29 of alternatives: well under a second', () => {
    const big = '\n'.repeat(3_000_000);
    let inner = multipart('multipart/mixed', 'mx', ['Content-Type: application/pgp-encrypted', '', big], ['Content-Type: application/octet-stream', '', 'x']);
    for (let i = 0; i < 29; i++) inner = multipart('multipart/alternative', `a${i}x`, ['Content-Type: text/plain', '', 't'], inner);
    const raw = utf8(eml('From: a@b.test', ...inner));
    const t = performance.now();
    mime(raw);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  test('Version: 1 is looked for in the first kilobyte only', () => {
    const shape = (body: string) => mime(eml(...ALICE, ...multipart('multipart/mixed', 'x',
      ['Content-Type: application/pgp-encrypted', '', body], ['Content-Type: application/octet-stream', '', 'x']))).problems.map((p) => p.code);
    expect(shape('Version: 1')).toContain('exchange-shape');
    expect(shape(' '.repeat(2000) + '\r\nVersion: 1')).not.toContain('exchange-shape');
    // a line cut at the kilobyte is not read as `Version: 1` (it could be `Version: 12`)
    expect(shape('x'.repeat(1012) + '\r\nVersion: 12')).not.toContain('exchange-shape');
  });
});

describe('finding 5: a withdrawn or blocked step labels nothing', () => {
  const armorPart = async () => {
    const armor = await encrypt('secret text', bob);
    return eml('Content-Type: multipart/mixed; boundary="x"', '', '--x', 'Content-Type: text/plain', '', armor, '--x',
      'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="a.bin"', 'Content-Transfer-Encoding: base64', '', 'aGVsbG8=', 'ZXZpbA==', '--x--', '');
  };

  test('an armored candidate under a signature whose subtree has mid-stream padding: no pending label, no verify step', async () => {
    const part = await armorPart();
    const raw = pgpSigned(MALLORY, part, await detach(part, mallory));
    const m0 = mime(raw);
    expect(m0.steps.map((s) => s.kind)).toEqual(['decrypt']);
    expect(m0.parts[0]!.protection).toEqual({ encrypted: false, signed: null });
    expect(unsigned(m0)).toBe(true);
    const m = await read(raw, app);
    expect(texts(m)).toEqual(['secret text']);
    expect(m.parts[0]!.protection.signed).toBeNull();
    expect(m.summary.signed).toBe('none');
  });

  test('a verdict for the would-be verify step is stale and labels nothing', async () => {
    const part = await armorPart();
    const raw = pgpSigned(MALLORY, part, await detach(part, mallory));
    // the id the verify step would have had, from the same message with the padding repaired
    const fixed = raw.replace('aGVsbG8=\r\nZXZpbA==', 'aGVsbG9ldmls');
    const would = mime(fixed).steps.find((s) => s.kind === 'verify')!.id.split('#')[0]!;
    const r = await unlock(raw, app);
    const m = mime(raw, { ...r, verdicts: { [`${would}#${'0'.repeat(32)}`]: [{ status: 'good', signer: ['mallory@evil.test'] }] } });
    expect(codes(m)).toContain('stale-result');
    expect(unsigned(m)).toBe(true);
    expect(m.summary.signed).toBe('none');
  });

  test('a base64 armored body with mid-stream padding under a signature: text, no step of any kind', async () => {
    const body = Buffer.from(await encrypt('secret text', bob));
    const part = eml('Content-Type: text/plain', 'Content-Transfer-Encoding: base64', '', body.subarray(0, 2).toString('base64'), body.subarray(2).toString('base64'));
    const m = await read(pgpSigned(MALLORY, part, await detach(part, mallory)), app);
    expect(m.steps).toEqual([]);
    expect(m.parts).toMatchObject([{ type: 'text', protection: { encrypted: false, signed: null } }]);
    expect(texts(m)[0]).toContain('-----BEGIN PGP MESSAGE-----');
    expect(m.problems).toContainEqual({ code: 'base64-junk', part: '1.1', blocking: true });
  });

  test('a cleartext block in a base64 body with mid-stream padding under a multipart/signed: text, no step', async () => {
    const block = Buffer.from(await clearsign('Yes, I agree.', alice));
    const part = eml('Content-Type: text/plain', 'Content-Transfer-Encoding: base64', '', block.subarray(0, 2).toString('base64'), block.subarray(2).toString('base64'));
    const m = await read(pgpSigned(ALICE, part, 'junk'), app);
    expect(m.steps).toEqual([]);
    expect(unsigned(m)).toBe(true);
    expect(m.summary).toEqual({ encrypted: 'none', signed: 'none', from: null });
  });
});

describe('findings 6 and 7: the cleartext digest has the charset; digests are per call', () => {
  test('a verdict for a block read as UTF-8 does not apply to the same bytes labelled koi8-r', async () => {
    const block = await clearsign('Preis: 5 £ für Bob', alice);
    const utf = eml(...ALICE, 'Content-Type: text/plain; charset=utf-8', '', block);
    const koi = eml(...ALICE, 'Content-Type: text/plain; charset=koi8-r', '', block);
    const r = await unlock(utf, app);
    const m = mime(koi, r);
    expect(kinds(m)).toEqual([['verify-cleartext', 'pending']]);
    expect(m.parts[0]!.protection.signed).toBe('pending');
    expect(codes(m)).toContain('stale-result');
    expect(m.steps[0]!.id).not.toBe(mime(utf).steps[0]!.id);
  });

  test('an input changed in place gets a new digest, not the old result', async () => {
    const part = eml('Content-Type: text/plain', '', 'I owe Bob 0005 EUR.');
    const raw = utf8(pgpSigned(ALICE, part, await detach(part, alice)));
    const r = await unlock(raw, app);
    expect(mime(raw, r).summary.signed).toBe('all');
    raw.set(utf8('9999'), Buffer.from(raw).indexOf('0005'));
    // other options, so mail.mime's own result cache (by identity, documented) is not what answers
    const m = mime(raw, { ...r, prefer: 'text' });
    expect(texts(m)).toEqual(['I owe Bob 9999 EUR.']);
    expect(kinds(m)).toEqual([['verify', 'pending']]);
    expect(m.parts[0]!.protection.signed).toBe('pending');
    expect(codes(m)).toContain('stale-result');
  });
});

describe('finding 8: reply', () => {
  test('an encrypted payload with protected headers and neither Reply-To nor From: reply is empty', async () => {
    for (const ct of ['text/plain; hp="cipher"', 'text/plain; protected-headers="v1"']) {
      const payload = eml(`Content-Type: ${ct}`, 'Subject: inner', '', 'hello');
      const m = await read(pgpMime(MALLORY, await encrypt(payload, bob)), app);
      expect(m.headers.subject, ct).toBe('inner');
      expect(m.reply, ct).toEqual([]);
      expect(addrs(m.headers.from)).toEqual(['mallory@evil.test']);
    }
    // without protected headers: the outer sender
    const plain = await read(pgpMime(MALLORY, await encrypt(eml('Content-Type: text/plain', '', 'hello'), bob)), app);
    expect(addrs(plain.reply)).toEqual(['mallory@evil.test']);
  });
});

test('a verify-cleartext id: the normalized charset label\'s length and bytes, then the block', async () => {
  const block = await clearsign('Hello', alice);
  const raw = eml(...ALICE, 'Content-Type: text/plain', '', block);
  const m = mime(raw);
  const s = m.steps[0] as Step & { kind: 'verify-cleartext' };
  expect(s).toMatchObject({ kind: 'verify-cleartext', charset: 'utf-8', state: 'pending' });
  expect(s.id).toBe(`1:1#${cleartextDigest('utf-8', bytes(raw, s.block))}`);
  expect(s.id).not.toBe(`1:1#${stepDigest(bytes(raw, s.block))}`);
  expect((m.parts[0] as Part).protection.step).toBe(s.id);
});
