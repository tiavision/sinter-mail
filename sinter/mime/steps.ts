// The steps' state and their building blocks (docs/proposals/sinter-mail-mime.md, section 5): the results an app
// fed back, the steps offered so far, the bytes a Ref names inside the reader, step digests, verdicts combined, and
// the line scanner that finds inline armor in a text body.
//
// Nothing here decrypts or verifies: a digest binds a result to the bytes it is for, and proves nothing else.
import type { Decrypted, Protection, Ref, Step, Verdict } from './types.js';
import type { Budget, Entity } from './scan.js';
import type { Ctx, Reader, Scope } from './show.js';
import type { Part } from './types.js';
import { canonicalize, transferDecode } from './decode.js';
import { newBudget, MAX_PAYLOAD } from './scan.js';
import { stepDigest, verifyDigest } from './sha256.js';

/** a signature over the payload's root (section 7): its step, its combined status, its signer */
export interface Sig { step: string; status: Verdict['status'] | 'pending'; signer: string[] }

/** what the root's steps found: where protected headers are read, and which signatures cover it */
export interface RootInfo {
  /** the cryptographic payload's root: the decrypted entity, or the signed part (section 6); null for none */
  payload: Entity | null;
  /** a decrypt step of the root is done: `payload` came from it */
  encrypted: boolean;
  /** signatures over the payload's root */
  sigs: Sig[];
  /** root decrypt steps offered (encrypted twice: at most 2) */
  decrypts: number;
}

/** a text part wholly one armored message in the root message: root step or not, decided once the walk is done */
export interface Candidate { part: Part & { type: 'encrypted' }; entity: Entity; ctx: Ctx; scope: Scope }

/** a text part wholly one cleartext-signed block, whose step was offered: a signature over the payload's root when
 * it is the root message's only part shown (protect.ts), decided once the walk is done */
export interface Cleartext { part: Part; entity: Entity; scope: Scope; sig: Sig }

export interface CryptoState {
  decrypted: Map<string, Decrypted>;
  verdicts: Map<string, Verdict[]>;
  open: Set<string>;
  budget: Budget;
  steps: Step[];
  /** ids of decrypt steps offered */
  decryptIds: Set<string>;
  /** ids of verify and verify-cleartext steps offered */
  verifyIds: Set<string>;
  /** the would-be ids of encrypted parts that could be opened */
  known: Set<string>;
  /** entities that may be decrypted on their own: the input's root, the signed part of a root multipart/signed, the
   * root of the first root payload (encrypted twice) */
  rootDecrypt: Set<Entity>;
  /** roots whose signature covers the payload's root: the input's root and each root payload's */
  payloadRoots: Set<Entity>;
  root: RootInfo;
  candidates: Candidate[];
  cleartexts: Cleartext[];
}

export interface StateOptions { decrypted?: Map<string, Decrypted>; verdicts?: Map<string, Verdict[]>; open?: readonly string[] }

export function newState(o: StateOptions, budget: Budget, root: Entity | null): CryptoState {
  return {
    decrypted: o.decrypted ?? new Map(), verdicts: o.verdicts ?? new Map(), open: new Set(o.open ?? []), budget, steps: [],
    decryptIds: new Set(), verifyIds: new Set(), known: new Set(),
    rootDecrypt: new Set(root ? [root] : []), payloadRoots: new Set(root ? [root] : []),
    root: { payload: null, encrypted: false, sigs: [], decrypts: 0 }, candidates: [], cleartexts: [],
  };
}

/** the reader's step state; a reader made without one (a test, a nested walk) gets an empty one whose root is unknown */
export function stateOf(r: Reader): CryptoState {
  return (r.crypto ??= newState({}, newBudget(), null));
}

/** whether one more step may be offered: the byte budget not overrun, fewer than 16 steps so far */
export const canOffer = (st: CryptoState) => !st.budget.overrun && st.budget.steps > 0;

/** offers a step (the caller checked canOffer) */
export function offer(st: CryptoState, step: Step): void {
  st.budget.steps--;
  st.steps.push(step);
  (step.kind === 'decrypt' ? st.decryptIds : st.verifyIds).add(step.id);
}

/** withdraws the last-offered step with this id (its subtree turned out to have a blocking problem) */
export function withdraw(st: CryptoState, id: string): void {
  const i = st.steps.findIndex((s) => s.id === id);
  if (i < 0) return;
  st.steps.splice(i, 1);
  st.budget.steps++;
  st.verifyIds.delete(id);
  st.decryptIds.delete(id);
}

/** the bytes a Ref names, from the reader's sources, as mail.bytes returns them */
export function refBytes(r: Reader, ref: Ref): Uint8Array {
  const src = r.sources.get(ref.source)!;
  let out = transferDecode(src, ref.start, ref.end, ref.encoding);
  if (ref.slice) out = out.slice(ref.slice[0], ref.slice[1]);
  return ref.canonical ? canonicalize(out) : out;
}

/** digests by source (the input, a payload: by identity) and Ref, so a cache miss of mail.mime hashes nothing twice */
const digests = new WeakMap<Uint8Array, Map<string, string>>();

const refKey = (ref: Ref) => `${ref.start}:${ref.end}:${ref.encoding}:${ref.canonical ? 1 : 0}:${ref.slice ? ref.slice.join(',') : ''}`;

function cached(r: Reader, ref: Ref, key: string, f: () => string): string {
  const src = r.sources.get(ref.source)!;
  let of = digests.get(src);
  if (!of) digests.set(src, (of = new Map()));
  let d = of.get(key);
  if (d === undefined) of.set(key, (d = f()));
  return d;
}

/** a decrypt or verify-cleartext step's digest: over the bytes `ref` names */
export const digestOf = (r: Reader, ref: Ref, bytes?: Uint8Array) =>
  cached(r, ref, 'd' + refKey(ref), () => stepDigest(bytes ?? refBytes(r, ref)));

/** a verify step's digest: the signed bytes' length, the signed bytes, the signature ("Settled for implementation") */
export const verifyDigestOf = (r: Reader, signed: Ref, signature: Ref) =>
  cached(r, signed, 'v' + refKey(signed) + '|' + refKey(signature), () => verifyDigest(refBytes(r, signed), refBytes(r, signature)));

const ORDER: Verdict['status'][] = ['bad', 'revoked', 'expired', 'no-key', 'unsupported'];

/**
 * Several verdicts for one step (section 7): `good` if any is, its signer the union of the good ones' signers;
 * otherwise the first status present in the order bad, revoked, expired, no-key, unsupported. No verdict at all
 * (an empty list) is `unsupported`: the app could not say.
 */
export function combine(vs: readonly Verdict[]): { status: Verdict['status']; signer: string[] } {
  const signer: string[] = [];
  let good = false;
  for (const v of vs) {
    if (v.status !== 'good') continue;
    good = true;
    for (const s of v.signer ?? []) if (!signer.includes(s)) signer.push(s);
  }
  if (good) return { status: 'good', signer };
  for (const s of ORDER) if (vs.some((v) => v.status === s)) return { status: s, signer };
  return { status: 'unsupported', signer };
}

/** a protection signed by a step, over `base` (its encryption kept) */
export function signedBy(base: Protection, step: string, status: Verdict['status'] | 'pending', signer: string[]): Protection {
  const p: Protection = { encrypted: base.encrypted, signed: status, step };
  if (base.opened) p.opened = true;
  if (status === 'good') p.signer = [...signer];
  return p;
}

/** what the library makes of a decrypt step's result */
export type Accepted =
  | { state: 'pending' }
  | { state: 'failed'; why: 'status' | 'integrity' | 'over-limit' }
  | { state: 'done'; d: Decrypted; plaintext: Uint8Array };

/**
 * A decrypt result checked (section 5): no result is pending; a status other than ok, or ok without integrity or
 * without plaintext, failed; a plaintext over 64 MiB, or over what the call's byte budget has left, failed as
 * over the limit.
 */
export function accept(st: CryptoState, id: string): Accepted {
  const d = st.decrypted.get(id);
  if (!d) return { state: 'pending' };
  if (d.status !== 'ok') return { state: 'failed', why: 'status' };
  if (d.integrity !== true || !(d.plaintext instanceof Uint8Array)) return { state: 'failed', why: 'integrity' };
  if (d.plaintext.length > MAX_PAYLOAD || d.plaintext.length > st.budget.bytes) return { state: 'failed', why: 'over-limit' };
  return { state: 'done', d, plaintext: d.plaintext };
}

// --- inline armor in a text body ---

const BEGIN_SIGNED = '-----BEGIN PGP SIGNED MESSAGE-----';
const BEGIN_SIGNATURE = '-----BEGIN PGP SIGNATURE-----';
const END_SIGNATURE = '-----END PGP SIGNATURE-----';
const BEGIN_MESSAGE = '-----BEGIN PGP MESSAGE-----';
const END_MESSAGE = '-----END PGP MESSAGE-----';

/** cleartext-signed and armored blocks a body may have; a fifth anchored one is text */
export const MAX_BLOCKS = 4;

/** an anchored block of a decoded body: offsets in its bytes */
export interface Block {
  kind: 'signed' | 'message';
  /** the BEGIN line's first byte */
  start: number;
  /** just past the END line's content (its line break not included) */
  end: number;
  /** just past the END line's line break */
  next: number;
  /** signed: the signed text, from after the armor headers' blank line to the line break before BEGIN PGP SIGNATURE */
  textStart: number;
  textEnd: number;
  /** signed: only `Hash:` armor headers and every line starting `-` dash-escaped; false is `armor-headers` */
  ok: boolean;
}

/** the end of the line's content at `pos` (before CRLF or LF) and the start of the next line */
function lineAt(b: Uint8Array, pos: number): [number, number] {
  let lf = b.indexOf(0x0a, pos);
  if (lf < 0) return [b.length, b.length];
  return [lf > pos && b[lf - 1] === 0x0d ? lf - 1 : lf, lf + 1];
}

/** whether the line [s, e) is `text`, trailing spaces and tabs aside */
function lineIs(b: Uint8Array, s: number, e: number, text: string): boolean {
  while (e > s && (b[e - 1] === 0x20 || b[e - 1] === 0x09)) e--;
  if (e - s !== text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[s + i] !== text.charCodeAt(i)) return false;
  return true;
}

const startsWith = (b: Uint8Array, s: number, e: number, text: string) => {
  if (e - s < text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[s + i] !== text.charCodeAt(i)) return false;
  return true;
};

const blankLine = (b: Uint8Array, s: number, e: number) => {
  for (let i = s; i < e; i++) if (b[i] !== 0x20 && b[i] !== 0x09) return false;
  return true;
};

export const whitespace = (b: Uint8Array, s: number, e: number) => {
  for (let i = s; i < e; i++) { const c = b[i]!; if (c !== 0x20 && c !== 0x09 && c !== 0x0d && c !== 0x0a) return false; }
  return true;
};

/** the cleartext-signed block whose BEGIN line starts at `start`, or null when it does not end (plain text) */
function signedBlock(b: Uint8Array, start: number, q: number): Block | null {
  let ok = true;
  // armor headers, up to a blank line
  for (;;) {
    if (q >= b.length) return null;
    const [e, n] = lineAt(b, q);
    if (blankLine(b, q, e)) { q = n; break; }
    if (lineIs(b, q, e, BEGIN_SIGNATURE)) return null;
    if (!startsWith(b, q, e, 'Hash:')) ok = false;
    q = n;
  }
  const textStart = q;
  let textEnd = q;
  // the signed text, up to BEGIN PGP SIGNATURE; the line break before it belongs to the armor
  for (;;) {
    if (q >= b.length) return null;
    const [e, n] = lineAt(b, q);
    if (lineIs(b, q, e, BEGIN_SIGNATURE)) {
      textEnd = q > textStart ? q - (q >= 2 && b[q - 2] === 0x0d ? 2 : 1) : textStart;
      q = n;
      break;
    }
    if (b[q] === 0x2d && !(q + 1 < e && b[q + 1] === 0x20)) ok = false;
    q = n;
  }
  for (;;) {
    if (q >= b.length) return null;
    const [e, n] = lineAt(b, q);
    if (lineIs(b, q, e, END_SIGNATURE)) return { kind: 'signed', start, end: e, next: n, textStart, textEnd, ok };
    q = n;
  }
}

/**
 * The anchored blocks of a decoded text body, in order: a line that is exactly `-----BEGIN PGP SIGNED MESSAGE-----`
 * or `-----BEGIN PGP MESSAGE-----` (trailing whitespace aside; a quoted or indented line never is), up to its END
 * line. At most 4 anchored BEGIN lines count; one without its END is text. Linear: each of the 4 scans at most to
 * the end once.
 */
export function findBlocks(b: Uint8Array): Block[] {
  const out: Block[] = [];
  let count = 0;
  for (let pos = 0; pos < b.length;) {
    const [e, n] = lineAt(b, pos);
    if (count < MAX_BLOCKS && b[pos] === 0x2d) {
      if (lineIs(b, pos, e, BEGIN_SIGNED)) {
        count++;
        const blk = signedBlock(b, pos, n);
        if (blk) { out.push(blk); pos = blk.next; continue; }
      } else if (lineIs(b, pos, e, BEGIN_MESSAGE)) {
        count++;
        let found: Block | null = null;
        for (let q = n; q < b.length;) {
          const [qe, qn] = lineAt(b, q);
          if (lineIs(b, q, qe, END_MESSAGE)) { found = { kind: 'message', start: pos, end: qe, next: qn, textStart: 0, textEnd: 0, ok: true }; break; }
          q = qn;
        }
        if (found) { out.push(found); pos = found.next; continue; }
      }
    }
    pos = n;
  }
  return out;
}

/** whether the bytes start (whitespace aside) with an armored message's BEGIN line */
export function armored(b: Uint8Array): boolean {
  let i = 0;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0d || b[i] === 0x0a)) i++;
  return startsWith(b, i, b.length, BEGIN_MESSAGE);
}

/**
 * The signed text as shown (section 5): dash-escaping removed and each line's trailing spaces and tabs removed (what
 * text-mode hashing covers), its line breaks kept.
 */
export function shownSigned(t: string): string {
  const out: string[] = [];
  for (let i = 0; i <= t.length;) {
    let lf = t.indexOf('\n', i);
    if (lf < 0) lf = t.length;
    let e = lf > i && t.charCodeAt(lf - 1) === 0x0d ? lf - 1 : lf;
    let s = i;
    if (t.charCodeAt(s) === 0x2d && t.charCodeAt(s + 1) === 0x20) s += 2;
    while (e > s && (t.charCodeAt(e - 1) === 0x20 || t.charCodeAt(e - 1) === 0x09)) e--;
    out.push(t.slice(s, e), t.slice(lf > i && t.charCodeAt(lf - 1) === 0x0d ? lf - 1 : lf, Math.min(lf + 1, t.length)));
    if (lf >= t.length) break;
    i = lf + 1;
  }
  return out.join('');
}
