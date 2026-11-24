// Where the walk meets OpenPGP structure (docs/proposals/sinter-mail-mime.md, section 5): which entities have a
// cryptographic shape, and what is shown for them. This is the seam wave 3 replaces: in wave 2 nothing is
// decrypted or verified and no step is made. An encrypted structure (multipart/encrypted, or Exchange's rewrite of
// one) is one attachment of kind `encrypted` holding the whole entity; a PGP/MIME signed structure shows its first
// part, unlabelled, and not its signature.
import type { Entity } from './scan.js';
import { attach, problem, textQuiet, walk, type Ctx, type Mode, type Reader, type Scope } from './show.js';
import { asciiLower } from './charset.js';
import { paramOf } from './scan.js';

export type Shape = 'encrypted' | 'exchange' | 'signed';

/** whether a text is `Version: 1` on a line of its own (application/pgp-encrypted's body, RFC 3156) */
const versionOne = (t: string) => t.split(/\r?\n/).some((l) => l.trim() === 'Version: 1');

const blank = (t: string) => t.trim() === '';

/**
 * The cryptographic shape of a multipart entity, by its declared structure only (wave 3 checks it strictly and
 * reports `crypto-shape`):
 * - `encrypted`: multipart/encrypted;
 * - `exchange`: Exchange's rewrite, multipart/mixed of an optional whitespace-only text/plain, then
 *   application/pgp-encrypted holding `Version: 1`, then application/octet-stream;
 * - `signed`: multipart/signed with protocol application/pgp-signature, two parts, the second
 *   application/pgp-signature.
 */
export function cryptoShape(r: Reader, e: Entity): Shape | null {
  if (e.boundary === null) return null;
  if (e.type === 'multipart/encrypted') return 'encrypted';
  const c = e.children;
  if (e.type === 'multipart/signed') {
    const protocol = asciiLower(paramOf(e.params, 'protocol') ?? '');
    return protocol === 'application/pgp-signature' && c.length === 2 && c[1]!.type === 'application/pgp-signature' ? 'signed' : null;
  }
  if (e.type === 'multipart/mixed' && (c.length === 2 || c.length === 3)) {
    const k = c.length - 2;
    if (k === 1 && !(c[0]!.type === 'text/plain' && !c[0]!.opaque && blank(textQuiet(r, c[0]!)))) return null;
    const v = c[k]!, data = c[k + 1]!;
    if (v.type === 'application/pgp-encrypted' && !v.opaque && versionOne(textQuiet(r, v)) && data.type === 'application/octet-stream') return 'exchange';
  }
  return null;
}

/** an application/pgp-encrypted part, or a `.pgp`, `.gpg` or `.asc` file that is not a key or a signature */
export function encryptedFile(e: Entity): boolean {
  if (e.type === 'application/pgp-encrypted' || e.type === 'application/pgp') return true;
  const name = asciiLower(paramOf(e.dispositionParams, 'filename') ?? paramOf(e.params, 'name') ?? '').trim();
  if (name.endsWith('.pgp') || name.endsWith('.gpg')) return true;
  return name.endsWith('.asc') && e.type !== 'application/pgp-signature' && e.type !== 'application/pgp-keys';
}

/** wave 2: an encrypted structure is one attachment of kind `encrypted`, its whole entity (`exchange-shape` noted) */
export function showEncrypted(r: Reader, e: Entity, shape: 'encrypted' | 'exchange', scope: Scope, _mode: Mode, ctx: Ctx): void {
  if (shape === 'exchange') problem(r, e, 'exchange-shape');
  attach(r, e, scope, 'encrypted', ctx);
}

/** wave 2: a PGP/MIME signed structure shows its first part, unlabelled; its signature is not an attachment */
export function showSigned(r: Reader, e: Entity, scope: Scope, mode: Mode, ctx: Ctx): void {
  walk(r, e.children[0]!, scope, mode, ctx);
}
