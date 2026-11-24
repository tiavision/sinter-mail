// Cut messages (docs/mail.md, "Large attachments: cut messages"): an input whose large leaf bodies a server cut out,
// with the `holes` option saying where. The reader is the only authority on whether a cut is one it allows: each
// hole must land on an empty leaf body in its own reading of the input, of a type whose body the reader never reads.
// A hole that does not is `hole-mismatch` (blocking: no step is offered), and the message's `cut` is 'invalid'.
//
// Offsets: the input is the whole message without the holes' bytes. A hole at [start, end) of the whole message is
// at `start - (the lengths of the holes before it)` in the input, where the cut body is now empty. A Ref of the
// input that touches a hole gets `missing`, its range in the whole message, which mail.bytes reads from the bytes the
// app fetched for it (bytes.ts checks them against the input and against the lexical rule below).
import type { Attachment, Hole, Message, Part, Ref, Step } from './types.js';
import type { Entity } from './scan.js';
import { all, isMultipart } from './scan.js';

/** one hole, placed in the input */
export interface Cut {
  /** its offset in the input */
  at: number;
  /** the bytes cut */
  length: number;
  /** the decoded size the server gave */
  size: number;
  /** the leaf whose body it is, once checked; null when it lands on none the reader allows */
  entity: Entity | null;
}

/** the holes placed in the input, or null when they are not in order, overlap or fall outside it */
export function place(holes: readonly Hole[], inputLength: number): Cut[] | null {
  const cuts: Cut[] = [];
  let before = 0, last = -1;
  for (const h of holes) {
    if (h.start < last || h.end <= h.start) return null;
    const at = h.start - before;
    if (at > inputLength) return null;
    cuts.push({ at, length: h.end - h.start, size: h.size, entity: null });
    before += h.end - h.start;
    last = h.end;
  }
  return cuts;
}

/** the types whose body the reader reads, or that hold structure: never cut */
const kept = (type: string) => type.startsWith('text/') || type.startsWith('message/') || isMultipart(type)
  || type === 'application/pgp-encrypted' || type === 'application/pgp-signature';

/** whether the reader allows the entity's body to be cut: a leaf of the input (no boundary, no children, no nested
 * message), read (not opaque), whose headers ended with a blank line, of a type whose body the reader never reads */
export const leafCut = (e: Entity) => e.source === 'input' && e.boundary === null && !e.children.length && !e.message
  && !e.opaque && e.headerEnded && !kept(e.type);

/** whether `size` is one a body of `length` encoded bytes can decode to: exactly its length for identity, at most
 * three quarters of it for base64, at most its length for quoted-printable */
const sizeFits = (e: Entity, length: number, size: number) =>
  e.encoding === 'identity' ? size === length : size <= (e.encoding === 'base64' ? Math.floor((length * 3) / 4) : length);

/** whether the blank line that ends a header block is just before `at` (an LF, then an empty line: LF or CRLF). The
 * scan clamps the body start of a part that ends right after its header block (the blank line doubling as the
 * delimiter's line break) back before that line: such an empty body is the header block's end, not a cut body */
const afterBlankLine = (src: Uint8Array, at: number) => {
  if (at < 1 || src[at - 1] !== 0x0a) return false;
  let i = at - 1;
  if (i > 0 && src[i - 1] === 0x0d) i--;
  return i > 0 && src[i - 1] === 0x0a;
};

/**
 * Matches each cut to the input's leaf whose empty body it is, one leafCut() allows, right after the blank line that
 * ends its headers, with a size its cut bytes can decode to; at most one cut per leaf. Returns whether every cut
 * matched.
 */
export function match(src: Uint8Array, root: Entity, cuts: Cut[]): boolean {
  const at = new Map<number, Entity>();
  for (const e of all(root)) if (e.bodyStart === e.end && leafCut(e)) at.set(e.bodyStart, e);
  let ok = true;
  for (const c of cuts) {
    const e = at.get(c.at);
    if (!e || !afterBlankLine(src, c.at) || !sizeFits(e, c.length, c.size)) { ok = false; continue; }
    at.delete(c.at);
    c.entity = e;
  }
  return ok;
}

/** the cuts a Ref of the input touches: those at or inside its range */
export function within(cuts: readonly Cut[] | undefined, ref: Ref): Cut[] {
  if (!cuts || ref.source !== 'input') return [];
  return cuts.filter((c) => ref.start <= c.at && c.at <= ref.end);
}

/** the Ref's `missing`, when it touches a cut */
function missingOf(cuts: readonly Cut[], ref: Ref): Ref['missing'] {
  const inside = within(cuts, ref);
  if (!inside.length) return undefined;
  let before = 0;
  for (const c of cuts) if (c.at < ref.start) before += c.length;
  const start = ref.start + before;
  const gaps: [number, number][] = [];
  let added = 0;
  for (const c of inside) {
    gaps.push([c.at - ref.start + added, c.length]);
    added += c.length;
  }
  return { start, end: ref.end + before + added, gaps };
}

/**
 * Every Ref of the message (its parts', attachments' and steps', nested messages' too) that touches a cut gets
 * `missing`; an attachment whose Ref does gets its size in the whole message: the hole's `size` for a cut body,
 * else the length of its range (an identity Ref: a nested message's bytes, an encrypted structure).
 */
export function annotate(m: Message, cuts: readonly Cut[]): void {
  const seen = new Set<Ref>();
  const mark = (ref: Ref) => {
    if (seen.has(ref)) return;
    seen.add(ref);
    const missing = missingOf(cuts, ref);
    if (missing) ref.missing = missing;
  };
  const attachment = (a: Attachment) => {
    mark(a.ref);
    const missing = a.ref.missing;
    if (!missing) return;
    const body = cuts.find((c) => c.entity && c.at === a.ref.start && c.at === a.ref.end);
    a.size = body ? body.size : a.ref.encoding === 'identity' ? missing.end - missing.start : a.size;
  };
  const step = (s: Step) => {
    if (s.kind === 'decrypt') mark(s.ciphertext);
    else if (s.kind === 'verify') { mark(s.signed); mark(s.signature); }
    else mark(s.block);
  };
  m.steps.forEach(step);
  const messages: Message[] = [m];
  while (messages.length) {
    const x = messages.pop()!;
    x.attachments.forEach(attachment);
    const parts: Part[] = [...x.parts];
    for (const p of parts) {
      if (p.type === 'message') { mark(p.ref); messages.push(p.message); }
      else if (p.type === 'encrypted') mark(p.ref);
    }
  }
}
