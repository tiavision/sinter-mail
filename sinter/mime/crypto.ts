// Where the walk meets OpenPGP structure (docs/proposals/sinter-mail-mime.md, section 5): which entities have a
// cryptographic shape, the steps they make, and what is shown for them before and after the app's results.
//
// - PGP/MIME encrypted (and Exchange's rewrite) at the root, or as the signed part of a root multipart/signed, or as
//   the root of the root's payload (encrypted twice, once): a decrypt step; with an accepted result its plaintext is
//   read as a second source and walked in place, labelled encrypted. Anywhere else: one `encrypted` part,
//   `not-root`, with the id its step would have; listed in `open`, it gets the step and is shown in place, opened.
// - PGP/MIME signed anywhere shown but in a nested message: a verify step labelling its first part's subtree.
// - Inline PGP in a text/plain body: anchored cleartext-signed blocks split the part around them, each a
//   verify-cleartext step; an armored message is a root decrypt step only as the whole body of the root's only
//   part shown (decided once the walk is done, `resolveCandidates`), otherwise an encrypted part, not-root.
// A blocking problem near crypto (in the entity, an ancestor or a descendant) makes no step: the part is shown
// unlabelled.
import type { Entity } from './scan.js';
import type { Part, Protection, Ref, Verdict } from './types.js';
import { all, paramOf, scan } from './scan.js';
import { attach, body, problem, textPart, textQuiet, walk, type Ctx, type Mode, type Reader, type Scope } from './show.js';
import { asciiLower, decodeText } from './charset.js';
import { base64Result, ignore } from './decode.js';
import {
  accept, armored, canOffer, combine, digestOf, findBlocks, offer, refBytes, shownSigned, signedBy, stateOf,
  verifyDigestOf, whitespace, withdraw, type CryptoState, type Sig,
} from './steps.js';
import { hasBareLF } from './decode.js';
import { legacyText, protectionForm, v1Display } from './hp.js';

export type Shape = 'encrypted' | 'exchange' | 'signed';

/** whether a text is `Version: 1` on a line of its own (application/pgp-encrypted's body, RFC 3156) */
const versionOne = (t: string) => t.split(/\r?\n/).some((l) => l.trim() === 'Version: 1');

const blank = (t: string) => t.trim() === '';

/**
 * The cryptographic shape of a multipart entity, by its declared structure:
 * - `encrypted`: multipart/encrypted (its exact shape is checked by showEncrypted: `crypto-shape`);
 * - `exchange`: Exchange's rewrite, multipart/mixed of an optional whitespace-only text/plain, then
 *   application/pgp-encrypted holding `Version: 1`, then application/octet-stream;
 * - `signed`: multipart/signed with protocol application/pgp-signature, two parts, the second
 *   application/pgp-signature (one claiming the protocol in another shape is `crypto-shape`, checkSigned).
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

/** the ciphertext part of an encrypted structure in the shape RFC 3156 (or Exchange's rewrite) requires, or null */
function cipherPart(r: Reader, e: Entity, shape: 'encrypted' | 'exchange'): Entity | null {
  const c = e.children;
  if (shape === 'exchange') return c[c.length - 1]!.opaque ? null : c[c.length - 1]!;
  const protocol = asciiLower(paramOf(e.params, 'protocol') ?? '');
  if (protocol !== 'application/pgp-encrypted' || c.length !== 2) return null;
  const [v, data] = c as [Entity, Entity];
  if (v.type !== 'application/pgp-encrypted' || v.opaque || !versionOne(textQuiet(r, v))) return null;
  return data.type === 'application/octet-stream' && !data.opaque ? data : null;
}

/** a multipart/signed that claims PGP (protocol, or an application/pgp-signature part) in another shape */
function malformedSigned(r: Reader, e: Entity): boolean {
  if (e.type !== 'multipart/signed' || e.boundary === null || cryptoShape(r, e) === 'signed') return false;
  return asciiLower(paramOf(e.params, 'protocol') ?? '') === 'application/pgp-signature' || e.children.some((c) => c.type === 'application/pgp-signature');
}

/** a malformed PGP multipart/signed is `crypto-shape` (blocking), and walked as multipart/mixed */
export function checkSigned(r: Reader, e: Entity): void {
  if (malformedSigned(r, e)) problem(r, e, 'crypto-shape', true);
}

/** the protection of what a decrypt step's plaintext shows: encrypted; signed by the signatures inside the
 * ciphertext, else by the signature the encrypted entity is under */
function payloadProtection(base: Protection, id: string, sigs: readonly Verdict[] | undefined, opened: boolean): Protection {
  let p: Protection;
  if (sigs?.length) { const c = combine(sigs); p = signedBy({ ...base, encrypted: true }, id, c.status, c.signer); }
  else if (base.signed !== null) {
    p = { encrypted: true, signed: base.signed };
    if (base.step !== undefined) p.step = base.step;
    if (base.signer) p.signer = [...base.signer];
  } else p = { encrypted: true, signed: null, step: id };
  if (opened || base.opened) p.opened = true;
  return p;
}

const encryptedPart = (id: string, contentType: string, ref: Ref, step: string, reason: (Part & { type: 'encrypted' })['reason'], ctx: Ctx): Part & { type: 'encrypted' } =>
  ({ id, contentType, protection: { ...ctx.protection }, type: 'encrypted', ref, step, reason });

/**
 * Offers the decrypt step `id` (the caller checked canOffer) and reads its result: the accepted plaintext, or the
 * reason the encrypted part shows instead. `at` is the entity problems are recorded on.
 */
function decrypt(r: Reader, st: CryptoState, at: Entity, part: string, id: string, ciphertext: Ref, bytes: Uint8Array) {
  const a = accept(st, id);
  offer(st, { id, state: a.state, part, kind: 'decrypt', ciphertext, armored: armored(bytes) });
  if (a.state === 'failed') {
    if (a.why === 'integrity') problem(r, at, 'integrity', true);
    if (a.why === 'over-limit') {
      if (st.decrypted.get(id)!.plaintext!.length > st.budget.bytes) {
        st.budget.overrun = true;
        problem(r, null, 'limit', true);
      } else problem(r, at, 'limit', true);
    }
  }
  return a;
}

/** PGP/MIME encrypted, or Exchange's rewrite of it */
export function showEncrypted(r: Reader, e: Entity, shape: 'encrypted' | 'exchange', scope: Scope, mode: Mode, ctx: Ctx): void {
  const st = stateOf(r);
  if (shape === 'exchange') problem(r, e, 'exchange-shape');
  const data = cipherPart(r, e, shape);
  if (!data) problem(r, e, 'crypto-shape', true);
  if (!data || mode !== 'show' || e.above || e.below) { attach(r, e, scope, 'encrypted', ctx); return; }
  const ciphertext: Ref = { source: data.source, start: data.bodyStart, end: data.end, encoding: data.encoding };
  const bytes = refBytes(r, ciphertext);
  const id = `${e.id}#${digestOf(r, ciphertext, bytes)}`;
  const ref: Ref = { source: e.source, start: e.start, end: e.end, encoding: 'identity' };
  const root = st.rootDecrypt.has(e) && e.nested === 0 && st.root.decrypts < 2;
  st.known.add(id);
  if (!root && !st.open.has(id)) { scope.parts.push(encryptedPart(e.id, e.type, ref, id, 'not-root', ctx)); return; }
  if (!canOffer(st)) {
    if (!st.budget.overrun) problem(r, e, 'limit', true);
    scope.parts.push(encryptedPart(e.id, e.type, ref, id, 'over-limit', ctx));
    return;
  }
  if (root) st.root.decrypts++;
  const a = decrypt(r, st, e, e.id, id, ciphertext, bytes);
  if (a.state !== 'done') {
    scope.parts.push(encryptedPart(e.id, e.type, ref, id, a.state === 'pending' ? 'pending' : a.why === 'over-limit' ? 'over-limit' : 'failed', ctx));
    return;
  }
  r.sources.set(id, a.plaintext);
  const s = scan(a.plaintext, { source: id, prefix: id + '/', parent: e }, st.budget);
  r.problems.push(...s.problems);
  // the payload's blocking problems are below the encrypted entity, and so below everything above it
  if (s.root.below) for (let x: Entity | null = e; x && !x.below; x = x.parent) x.below = true;
  const R = s.root;
  const protection = payloadProtection(ctx.protection, id, a.d.signatures, !root);
  const sub: Ctx = { ...ctx, protection, legacy: false, hide: null };
  if (root) {
    st.root.encrypted = true;
    st.payloadRoots.add(R);
    if (st.root.decrypts < 2) st.rootDecrypt.add(R);
    const P = cryptoShape(r, R) === 'signed' ? R.children[0]! : R;
    st.root.payload = P;
    if (a.d.signatures?.length) st.root.sigs.push({ step: id, ...combine(a.d.signatures) });
    sub.legacy = protectionForm(P)?.form === 'hp';
    sub.hide = v1Display(P);
  }
  walk(r, R, scope, 'show', sub);
}

/** whether a signed subtree has a blocking problem: one recorded, or base64 with padding mid-stream in any part of it
 * (every base64 part is decoded for this: one never decoded is not assumed clean) */
function signedBlocked(r: Reader, e: Entity): boolean {
  let bad = false;
  for (const x of all(e)) {
    if (x.boundary !== null || x.opaque || x.encoding !== 'base64' || x.children.length || x.message) continue;
    if (x.midPadding || base64Result(r.sources.get(x.source)!, x.bodyStart, x.end).midPadding) {
      x.midPadding = true;
      problem(r, x, 'base64-junk', true);
      bad = true;
    }
  }
  return bad || e.above || e.below;
}

/** parts and attachments a walk added from these offsets on, nested messages' included, whose label is `step` */
function relabel(scope: Scope, parts: number, attachments: number, step: string, base: Protection): void {
  const back = (id: string, p: Protection): Protection => {
    if (p.step !== step) return p;
    const q: Protection = { encrypted: p.encrypted, signed: base.signed };
    if (p.opened) q.opened = true;
    const slash = id.lastIndexOf('/');
    // under a decryption below the signature, the decrypt step labels it
    const decryptStep = p.encrypted && !base.encrypted && slash > 0 ? id.slice(0, slash) : base.step;
    if (base.signed !== null ? base.step !== undefined : decryptStep !== undefined) q.step = base.signed !== null ? base.step : decryptStep;
    if (base.signer) q.signer = [...base.signer];
    return q;
  };
  const stack: Part[] = scope.parts.slice(parts);
  for (const a of scope.attachments.slice(attachments)) a.protection = back(a.id, a.protection);
  while (stack.length) {
    const p = stack.pop()!;
    p.protection = back(p.id, p.protection);
    if (p.type === 'message') {
      for (const a of p.message.attachments) a.protection = back(a.id, a.protection);
      stack.push(...p.message.parts);
    }
  }
}

/** PGP/MIME signed: a verify step for its first part's subtree, decided once that subtree is walked */
export function showSigned(r: Reader, e: Entity, scope: Scope, mode: Mode, ctx: Ctx): void {
  const st = stateOf(r);
  const signed = e.children[0]!, sig = e.children[1]!;
  const isRoot = st.payloadRoots.has(e);
  if (isRoot && e.source === 'input' && e.nested === 0) {
    // sign over encrypt: the signed part may be decrypted on its own; signed only: it is the payload
    st.rootDecrypt.add(signed);
    if (!st.root.encrypted) st.root.payload = signed;
  }
  if (mode !== 'show' || e.nested > 0 || e.above || e.below || !canOffer(st)) {
    if (mode === 'show' && e.nested === 0 && !e.above && !e.below && !st.budget.overrun) problem(r, e, 'limit', true);
    walk(r, signed, scope, mode, ctx);
    return;
  }
  const signedRef: Ref = { source: e.source, start: signed.start, end: signed.end, encoding: 'identity' };
  if (hasBareLF(r.sources.get(e.source)!, signed.start, signed.end)) signedRef.canonical = true;
  const signature: Ref = { source: sig.source, start: sig.bodyStart, end: sig.end, encoding: sig.encoding };
  const id = `${e.id}#${verifyDigestOf(r, signedRef, signature)}`;
  const vs = st.verdicts.get(id);
  const c = vs ? combine(vs) : { status: 'pending' as const, signer: [] };
  const micalg = paramOf(e.params, 'micalg');
  offer(st, { id, state: vs ? 'done' : 'pending', part: e.id, kind: 'verify', signed: signedRef, signature, micalg: micalg === null ? null : asciiLower(micalg) });
  const parts = scope.parts.length, attachments = scope.attachments.length;
  walk(r, signed, scope, 'show', { ...ctx, protection: signedBy(ctx.protection, id, c.status, c.signer) });
  if (signedBlocked(r, e)) {
    // a blocking problem in the signed subtree (found while walking it, or mid-stream padding): no step, no label
    withdraw(st, id);
    relabel(scope, parts, attachments, id, ctx.protection);
    return;
  }
  if (signedRef.canonical) problem(r, e, 'canonicalized');
  if (isRoot) st.root.sigs.push({ step: id, ...c });
}

/** a text/plain body as its own source: an inline PGP payload ("a body as it is"), read as UTF-8 */
function textEntity(st: CryptoState, id: string, source: string, length: number, parent: Entity): Entity {
  st.budget.bytes -= length;
  st.budget.parts--;
  return {
    id, source, parent, depth: parent.depth + 1, nested: parent.nested, root: true, start: 0, bodyStart: 0, end: length,
    fields: [], headerEnded: true, type: 'text/plain', params: [], disposition: null, dispositionParams: [], encoding: 'identity',
    opaque: null, boundary: null, closed: false, children: [], message: null, problems: [], blocking: [], above: false,
    below: false, midPadding: false,
  };
}

/**
 * An inline armored message `ref` (part `pid`, would-be step `id`): a root step, or with `open` an opened one, its
 * plaintext shown in place as a text body; otherwise an encrypted part.
 */
function inlineEncrypted(r: Reader, e: Entity, pid: string, id: string, ref: Ref, scope: Scope, ctx: Ctx, root: boolean): void {
  const st = stateOf(r);
  st.known.add(id);
  if (!root && !st.open.has(id)) { scope.parts.push(encryptedPart(pid, e.type, ref, id, 'not-root', ctx)); return; }
  if (!canOffer(st)) {
    if (!st.budget.overrun) problem(r, e, 'limit', true);
    scope.parts.push(encryptedPart(pid, e.type, ref, id, 'over-limit', ctx));
    return;
  }
  if (root) st.root.decrypts++;
  const a = decrypt(r, st, e, pid, id, ref, refBytes(r, ref));
  if (a.state !== 'done') {
    scope.parts.push(encryptedPart(pid, e.type, ref, id, a.state === 'pending' ? 'pending' : a.why === 'over-limit' ? 'over-limit' : 'failed', ctx));
    return;
  }
  r.sources.set(id, a.plaintext);
  const t = textEntity(st, `${id}/1`, id, a.plaintext.length, e);
  const sub: Ctx = { ...ctx, protection: payloadProtection(ctx.protection, id, a.d.signatures, !root), legacy: false, hide: null };
  if (root) {
    st.root.encrypted = true;
    st.root.payload = t;
    if (a.d.signatures?.length) st.root.sigs.push({ step: id, ...combine(a.d.signatures) });
  }
  if (!showText(r, t, scope, sub)) scope.parts.push(textPart(r, t, sub));
}

/** a plain text part of `bytes[s, e)` of the entity, `id` */
function segment(r: Reader, e: Entity, id: string, bytes: Uint8Array, s: number, end: number, ctx: Ctx): Part {
  const p = textPart(r, e, ctx) as Part & { type: 'text' };
  p.id = id;
  p.text = decodeText(bytes.subarray(s, end), paramOf(e.params, 'charset'), (c) => problem(r, e, c));
  return p;
}

/**
 * A text/plain or text/html part shown, where crypto changes what is shown; false leaves it to show.ts:
 * - in the root payload of a done decrypt step whose root has `hp`, a part with `hp-legacy-display="1"`: a text part
 *   without its legacy display (up to and including the first blank line), an HTML part `legacyDisplay: true`;
 * - a text/plain body with anchored inline armor (section 5).
 */
export function showText(r: Reader, e: Entity, scope: Scope, ctx: Ctx): boolean {
  if (ctx.legacy && paramOf(e.params, 'hp-legacy-display') === '1') {
    const p = textPart(r, e, ctx);
    if (p.type === 'html') {
      p.legacyDisplay = true;
      scope.parts.push(p);
      scope.html.push({ part: p, related: ctx.related });
    } else if (p.type === 'text') {
      const t = legacyText(p.text);
      if (t === null) problem(r, e, 'legacy-display');
      else p.text = t;
      scope.parts.push(p);
    }
    return true;
  }
  if (e.type !== 'text/plain' || !textQuiet(r, e).includes('-----BEGIN PGP ')) return false;
  const bytes = body(r, e, ignore);
  const found = findBlocks(bytes);
  if (found.some((b) => b.kind === 'signed' && !b.ok)) problem(r, e, 'armor-headers');
  // near crypto: no step, the part shown as text; a nested message's cleartext signatures make no step either
  if (e.above) return false;
  const nested = e.nested > 0;
  const blocks = found.filter((b) => b.kind === 'message' || (b.ok && !nested));
  if (!blocks.length) return false;
  for (const c of r.texts.get(e)?.codes ?? []) problem(r, e, c);
  const st = stateOf(r);
  const whole: Ref = { source: e.source, start: e.bodyStart, end: e.end, encoding: e.encoding };
  if (blocks.length === 1 && blocks[0]!.kind === 'message' && whitespace(bytes, 0, blocks[0]!.start) && whitespace(bytes, blocks[0]!.next, bytes.length)) {
    // wholly one armored message: a root step only as the root message's only part shown, decided after the walk
    const id = `${e.id}#${digestOf(r, whole, bytes)}`;
    if (e.source === 'input' && !nested) {
      st.known.add(id);
      const part = encryptedPart(e.id, e.type, whole, id, 'not-root', ctx);
      scope.parts.push(part);
      st.candidates.push({ part, entity: e, ctx, scope });
    } else inlineEncrypted(r, e, e.id, id, whole, scope, ctx, false);
    return true;
  }
  const charset = asciiLower(paramOf(e.params, 'charset') ?? 'utf-8');
  // wholly one cleartext-signed block (whitespace aside): its signature may cover the root message (protect.ts)
  const wholeSigned = blocks.length === 1 && blocks[0]!.kind === 'signed' && !nested
    && whitespace(bytes, 0, blocks[0]!.start) && whitespace(bytes, blocks[0]!.next, bytes.length);
  let n = 0, pos = 0;
  for (const b of blocks) {
    if (!whitespace(bytes, pos, b.start)) scope.parts.push(segment(r, e, `${e.id}:${++n}`, bytes, pos, b.start, ctx));
    const pid = `${e.id}:${++n}`;
    const ref: Ref = { ...whole, slice: [b.start, b.end] };
    const id = `${pid}#${digestOf(r, ref, bytes.slice(b.start, b.end))}`;
    if (b.kind === 'message') inlineEncrypted(r, e, pid, id, ref, scope, ctx, false);
    else {
      let protection = { ...ctx.protection }, sig: Omit<Sig, 'step'> | null = null;
      if (canOffer(st)) {
        const vs = st.verdicts.get(id);
        const c = vs ? combine(vs) : { status: 'pending' as const, signer: [] };
        offer(st, { id, state: vs ? 'done' : 'pending', part: pid, kind: 'verify-cleartext', block: ref, charset });
        protection = signedBy(ctx.protection, id, c.status, c.signer);
        sig = c;
      } else if (!st.budget.overrun) problem(r, e, 'limit', true);
      const p = segment(r, e, pid, bytes, b.textStart, b.textEnd, { ...ctx, protection }) as Part & { type: 'text' };
      p.text = shownSigned(p.text);
      p.flowed = false;
      p.delsp = false;
      scope.parts.push(p);
      if (wholeSigned && sig) st.cleartexts.push({ part: p, entity: e, scope, sig: { step: id, status: sig.status, signer: [...sig.signer] } });
    }
    pos = b.next;
  }
  if (!whitespace(bytes, pos, bytes.length)) scope.parts.push(segment(r, e, `${e.id}:${++n}`, bytes, pos, bytes.length, ctx));
  return true;
}

/**
 * After the root message's walk: each text part wholly one armored message is a root decrypt step when it is the
 * root message's only part shown (and nothing else was decrypted as the root); otherwise not-root, opened with
 * `open`. What it decrypts to takes its place.
 */
export function resolveCandidates(r: Reader, scope: Scope): void {
  const st = stateOf(r);
  for (const c of st.candidates) {
    const at = c.scope.parts.indexOf(c.part);
    if (at < 0) continue;
    const root = c.scope === scope && scope.parts.length === 1 && st.root.decrypts === 0 && !st.root.encrypted;
    if (!root && !st.open.has(c.part.step)) continue;
    const sub: Scope = { parts: [], attachments: [], calendar: [], html: [], of: new Map() };
    inlineEncrypted(r, c.entity, c.part.id, c.part.step, c.part.ref, sub, c.ctx, root);
    c.scope.parts.splice(at, 1, ...sub.parts);
  }
  st.candidates.length = 0;
}
