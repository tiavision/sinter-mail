// What the crypto tests share: real keys and messages made with openpgp.js (a dev dependency, never imported by the
// library), an app's decrypt and verify built as section 1 of docs/proposals/sinter-mail-mime.md has them, and its
// action recipe.
import * as openpgp from 'openpgp';
import { mime } from '../sinter/mime.js';
import { bytes } from '../sinter/bytes.js';
import type { Decrypted, Message, MimeOptions, Part, Ref, Step, Verdict } from '../sinter/mime/types.js';

export interface Keys { privateKey: openpgp.PrivateKey; publicKey: openpgp.PublicKey }

export const key = (name: string, email: string): Promise<Keys> =>
  openpgp.generateKey({ type: 'curve25519', userIDs: [{ name, email }], format: 'object' }) as Promise<Keys>;

export const utf8 = (s: string) => new TextEncoder().encode(s);
export const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
/** a message from lines, joined with CRLF */
export const eml = (...lines: string[]) => lines.join('\r\n');
export const multipart = (type: string, boundary: string, ...parts: string[][]) =>
  [`Content-Type: ${type}; boundary="${boundary}"`, '', ...parts.flatMap((p) => [`--${boundary}`, ...p]), `--${boundary}--`, ''];

/** an armored ciphertext of `plaintext` to `to`, signed inside (one-pass) by `signer` when given */
export async function encrypt(plaintext: string | Uint8Array, to: Keys, signer?: Keys): Promise<string> {
  const message = await openpgp.createMessage({ binary: typeof plaintext === 'string' ? utf8(plaintext) : plaintext });
  return crlf(await openpgp.encrypt({ message, encryptionKeys: to.publicKey, ...(signer ? { signingKeys: signer.privateKey } : {}) }) as string);
}

/** a detached armored signature over the bytes as given (the canonical bytes, for PGP/MIME) */
export async function detach(signed: string | Uint8Array, signer: Keys): Promise<string> {
  const message = await openpgp.createMessage({ binary: typeof signed === 'string' ? utf8(signed) : signed });
  return crlf(await openpgp.sign({ message, signingKeys: signer.privateKey, detached: true }) as string);
}

/** a cleartext-signed block of `text`, CRLF line ends */
export async function clearsign(text: string, signer: Keys): Promise<string> {
  const message = await openpgp.createCleartextMessage({ text });
  return crlf(await openpgp.sign({ message, signingKeys: signer.privateKey }) as string).replace(/\r\n$/, '');
}

/** PGP/MIME encrypted: the outer headers, then multipart/encrypted around `armor` */
export const pgpMime = (outer: string[], armor: string, boundary = 'enc') => eml(...outer, 'MIME-Version: 1.0',
  ...multipart('multipart/encrypted; protocol="application/pgp-encrypted"', boundary,
    ['Content-Type: application/pgp-encrypted', 'Content-Description: PGP/MIME version identification', '', 'Version: 1', ''],
    ['Content-Type: application/octet-stream; name="encrypted.asc"', 'Content-Disposition: inline; filename="encrypted.asc"', '', armor]));

/** PGP/MIME signed of the entity `signed` (its headers and body, CRLF), with `signature` */
export const pgpSigned = (outer: string[], signed: string, signature: string, boundary = 'sig') => eml(...outer, 'MIME-Version: 1.0',
  `Content-Type: multipart/signed; micalg=pgp-sha512; protocol="application/pgp-signature"; boundary="${boundary}"`, '',
  `--${boundary}`, signed, `--${boundary}`, 'Content-Type: application/pgp-signature; name="signature.asc"', '', signature, `--${boundary}--`, '');

/** the app's key ring: the keys it knows, and whom it trusts each one for */
export class App {
  constructor(readonly me: Keys, readonly ring: Keys[]) {}

  /** a signature's verdict: no-key when the ring lacks its key; good with the key's user IDs' addresses; else bad */
  async verdict(sig: openpgp.VerifyMessageResult['signatures'][number]): Promise<Verdict> {
    const k = this.ring.find((x) => x.publicKey.getKeys(sig.keyID).length);
    if (!k) return { status: 'no-key' };
    try {
      await sig.verified;
      return { status: 'good', fingerprint: k.publicKey.getFingerprint(), signer: k.publicKey.users.map((u) => u.userID!.email) };
    } catch {
      return { status: 'bad', fingerprint: k.publicKey.getFingerprint() };
    }
  }

  /** decrypt as section 1 asks: integrity-protected only, and the message must have been encrypted */
  async decrypt(ciphertext: Uint8Array): Promise<Decrypted> {
    try {
      const text = new TextDecoder().decode(ciphertext);
      const message = text.includes('-----BEGIN PGP MESSAGE-----')
        ? await openpgp.readMessage({ armoredMessage: text })
        : await openpgp.readMessage({ binaryMessage: ciphertext });
      if (!message.getEncryptionKeyIDs().length) return { status: 'failed', integrity: false };
      const r = await openpgp.decrypt({
        message, decryptionKeys: this.me.privateKey, verificationKeys: this.ring.map((k) => k.publicKey), format: 'binary',
        config: { allowUnauthenticatedMessages: false },
      });
      return { status: 'ok', plaintext: r.data as Uint8Array, integrity: true, signatures: await Promise.all(r.signatures.map((s) => this.verdict(s))) };
    } catch {
      return { status: 'failed', integrity: false };
    }
  }

  /** a verify step: detached over the signed bytes, or a cleartext-signed block */
  async verify(step: Step, get: (ref: Ref) => Uint8Array): Promise<Verdict[]> {
    const keys = this.ring.map((k) => k.publicKey);
    try {
      if (step.kind === 'verify') {
        const signature = await openpgp.readSignature({ armoredSignature: new TextDecoder().decode(get(step.signature)) });
        const r = await openpgp.verify({ message: await openpgp.createMessage({ binary: get(step.signed) }), signature, verificationKeys: keys });
        return Promise.all(r.signatures.map((s) => this.verdict(s)));
      }
      if (step.kind === 'verify-cleartext') {
        const message = await openpgp.readCleartextMessage({ cleartextMessage: new TextDecoder(step.charset).decode(get(step.block)) });
        const r = await openpgp.verify({ message, verificationKeys: keys });
        return Promise.all(r.signatures.map((s) => this.verdict(s)));
      }
    } catch {
      return [{ status: 'bad' }];
    }
    return [];
  }
}

export type Results = { decrypted: Record<string, Decrypted>; verdicts: Record<string, Verdict[]>; open: string[] };

/** section 1's action: run the pending steps until none is, then the results (bounded, in case a step never settles) */
export async function unlock(raw: Uint8Array | string, app: App, open: string[] = [], prior: Partial<Results> = {}): Promise<Results> {
  const r: Results = { decrypted: { ...prior.decrypted }, verdicts: { ...prior.verdicts }, open };
  let rounds = 0;
  for (let msg = mime(raw, r); msg.steps.some((s) => s.state === 'pending'); msg = mime(raw, r)) {
    if (++rounds > 20) throw new Error('the steps never settle');
    for (const s of msg.steps.filter((x) => x.state === 'pending')) {
      if (s.kind === 'decrypt') r.decrypted[s.id] = await app.decrypt(bytes(raw, s.ciphertext, r));
      else r.verdicts[s.id] = await app.verify(s, (ref) => bytes(raw, ref, r));
    }
  }
  return r;
}

/** the message once every step has run */
export async function read(raw: Uint8Array | string, app: App, open: string[] = [], options: MimeOptions = {}): Promise<Message> {
  return mime(raw, { ...options, ...(await unlock(raw, app, open)) });
}

export const texts = (m: Message) => m.parts.map((p: Part) => (p.type === 'text' ? p.text : p.type === 'html' ? p.html : p.type));
export const codes = (m: Message) => m.problems.map((p) => p.code);
export const addrs = (a: { address: string | null }[]) => a.map((x) => x.address);
