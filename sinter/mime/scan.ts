// The entity scan (docs/proposals/sinter-mail-mime.md, sections 2, 3 and 4): one source's bytes (the input, or in
// wave 3 a decrypted payload) to its tree of entities, with every repair and refusal recorded on the entity it
// concerns. Nothing is decoded here but headers: bodies stay byte ranges until show.ts knows what each one is.
//
// One pass over the lines, with an explicit stack of the entities open at the current line (no recursion):
// a line is a delimiter only when it is exactly `--`, an open multipart's boundary, optional transport padding
// (spaces and tabs) and the line end, or the same with `--` before the padding for the close. CRLF and bare LF end
// a line; a bare CR is a character (but a CR as the input's last byte after a delimiter, a CRLF the end cut). The
// line break before a delimiter belongs to the delimiter. A line starting `--` has its padding stripped once and is
// looked up among the open boundaries by length, last byte and hash, then compared once, so the work per line is a
// constant times its length however many boundaries are open and however much they share; past the last open
// boundary the rest of a body is not read at all.
import type { ProblemCode, Ref } from './types.js';
import { contentType, param, parameterField, readHeaders, transferEncoding, type ParameterField, type RawField } from './headers.js';

/** entities nested deeper than this (the source's root is level 1) are one attachment of their bytes */
export const MAX_DEPTH = 32;
/** entities in one call, every source together */
export const MAX_PARTS = 1_000;
/** message/rfc822 and message/global levels */
export const MAX_NESTED = 8;
/** bytes read in one call, every source together */
export const MAX_BYTES = 256 * 1024 * 1024;
/** one decrypted payload (wave 3) */
export const MAX_PAYLOAD = 64 * 1024 * 1024;
/** steps offered by one call (wave 3) */
export const MAX_STEPS = 16;
/** RFC 2046's longest boundary */
export const MAX_BOUNDARY = 70;

/**
 * The limits one `mail.mime` call has left, shared by every source it reads (the input, each decrypted payload,
 * each nested message), so feeding results back cannot multiply the work.
 */
export interface Budget {
  /** bytes still to be read */
  bytes: number;
  /** entities still to be made */
  parts: number;
  /** steps still to be offered (wave 3) */
  steps: number;
  /** the byte budget ran out: a `limit` problem with `part: null` was recorded, which stops every step not yet offered */
  overrun: boolean;
}

export const newBudget = (): Budget => ({ bytes: MAX_BYTES, parts: MAX_PARTS, steps: MAX_STEPS, overrun: false });

/** why an entity is shown as one attachment of its bytes rather than read further */
export type Opaque = 'limit' | 'boundary-invalid' | 'encoding-unknown';

/** one entity of a source: a message's root, a body part, or the root of a nested message */
export interface Entity {
  /** the IMAP-style path (`1`, `1.2`, `1.2.1`; inside a decrypted payload `<step id>/1.2`) */
  id: string;
  /** 'input', or the decrypt step whose plaintext holds it */
  source: string;
  parent: Entity | null;
  /** 1 for a source's root; a nested message's root is one level below its message/rfc822 entity */
  depth: number;
  /** message/rfc822 and message/global entities above it (its own, for a nested root) */
  nested: number;
  /** a message's root: the source's, or a nested message's (read with the root's header limit) */
  root: boolean;
  /** offset of its first header byte */
  start: number;
  /** offset of its body (just past the blank line, or where its headers ran out) */
  bodyStart: number;
  /** offset just before the line break of the delimiter that ends it, or the source's end */
  end: number;
  /** its header fields, in order (headers.readHeaders) */
  fields: RawField[];
  /** whether a blank line ended its headers */
  headerEnded: boolean;
  /** `type/subtype`, lowercased, after RFC 2045's defaults (and message/rfc822 inside multipart/digest) */
  type: string;
  /** Content-Type's parameters (headers.parameterField) */
  params: [string, string][];
  /** Content-Disposition: `inline`, `attachment` (any other token too, RFC 2183 2.8), or null when absent */
  disposition: 'attachment' | 'inline' | null;
  dispositionParams: [string, string][];
  /** the transfer encoding its body is read with; identity for multipart and message, and when unknown */
  encoding: Ref['encoding'];
  /** set when the entity is one attachment of its bytes (`limit`, `boundary-invalid`) or of its undecoded body
   * (`encoding-unknown`) */
  opaque: Opaque | null;
  /** a multipart's boundary, when valid (and the entity is not opaque); null otherwise */
  boundary: string | null;
  /** a multipart: whether its close delimiter was seen */
  closed: boolean;
  /** a multipart's children, in order */
  children: Entity[];
  /** message/rfc822 or message/global: the root of the nested message */
  message: Entity | null;
  /** every problem concerning it, by code, in order */
  problems: ProblemCode[];
  /** its blocking problems */
  blocking: ProblemCode[];
  /** it or an ancestor (in this source, and above the source's root when a parent was given) has a blocking
   * problem: "Near crypto" stops its steps */
  above: boolean;
  /** it or a descendant has a blocking problem: a signature over it labels nothing (section 5) */
  below: boolean;
  /** base64 with padding mid-stream was decoded in its body (show.ts sets it): blocking under a signature */
  midPadding: boolean;
}

/** a problem as recorded: the entity it concerns (null: the whole call) */
export interface Found { entity: Entity | null; code: ProblemCode; blocking: boolean }

export interface Scanned {
  root: Entity;
  /** in the order found; one per entity and code */
  problems: Found[];
  src: Uint8Array;
  source: string;
  /** the offset the scan stopped at: the source's length, or less when the byte budget ran out */
  end: number;
}

/** where a source's tree begins: the input's root, or (wave 3) a decrypted payload's */
export interface ScanStart {
  /** 'input' (default), or the decrypt step's id */
  source?: string;
  /** put before the root's `1`: '' for the input, `<step id>/` for a payload */
  prefix?: string;
  /** the entity the source stands for (an encrypted entity): depth, nesting and blocking continue from it */
  parent?: Entity | null;
}

/** the blocking codes of section 2's table; `parameter-conflict` and `base64-junk` depend on the case */
const BLOCKING = new Set<ProblemCode>(['boundary-missing-close', 'boundary-invalid', 'duplicate-field', 'duplicate-parameter',
  'header-malformed', 'content-type-invalid', 'encoding-on-multipart', 'encoding-unknown', 'crypto-shape', 'limit',
  'control-in-structure', 'integrity', 'parameter-conflict', 'parameter-malformed']);

export const isBlocking = (code: ProblemCode) => BLOCKING.has(code);

/** parameters whose conflicting forms block; a filename's do not */
const STRUCTURAL = new Set(['boundary', 'protocol', 'micalg', 'start', 'type']);

/** the MIME fields a repetition of which is `duplicate-field` (Content-ID too: it decides multipart/related's root) */
const MIME_FIELDS = new Set(['content-type', 'content-transfer-encoding', 'content-disposition', 'content-id']);

/** RFC 2046's bchars: digits, letters, `'()+_,-./:=?` and space */
const bchar = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
  || c === 0x27 || c === 0x28 || c === 0x29 || c === 0x2b || c === 0x5f || c === 0x2c || c === 0x2d || c === 0x2e
  || c === 0x2f || c === 0x3a || c === 0x3d || c === 0x3f || c === 0x20;

/** whether `b` is a boundary RFC 2046 allows: 1 to 70 bchars, not ending in a space */
export function boundaryValid(b: string): boolean {
  if (b.length < 1 || b.length > MAX_BOUNDARY || b.charCodeAt(b.length - 1) === 0x20) return false;
  for (let i = 0; i < b.length; i++) if (!bchar(b.charCodeAt(i))) return false;
  return true;
}

/** a parameter's value, the RFC 2231 form first (it wins over the plain one) */
export function paramOf(params: readonly (readonly [string, string])[], name: string): string | null {
  return param(params, name + '*') ?? param(params, name);
}

export const isMultipart = (type: string) => type.startsWith('multipart/');
/** the message types whose body is read as a nested message */
export const isNestedMessage = (type: string) => type === 'message/rfc822' || type === 'message/global';

interface Open extends Entity, Interpreted {
  /** its index in the stack */
  k: number;
  /** its boundary's bytes */
  b: Uint8Array | null;
  /** past the part limit: its delimiters are no longer looked for */
  sealed: boolean;
}

/**
 * The entity tree of `src`. Never throws. Each problem is recorded on the entity it concerns, blocking as section
 * 2's table says (`parameter-conflict` only for boundary, protocol, micalg, start and type); after the walk each
 * entity's `above` and `below` say whether a blocking problem is in it or above it, in it or below it.
 *
 * Limits (section 4), counted in `budget`: past the byte budget the rest of the source is not read (`limit`, part
 * null); an entity deeper than 32 levels, a nested message deeper than 8, or a nested message's root past the part
 * limit makes its entity opaque (`limit`); a multipart whose next child would pass the part limit gets one opaque
 * child (`limit`) holding the rest of its body, and its later delimiters are not looked for.
 */
export function scan(src: Uint8Array, start: ScanStart = {}, budget: Budget = newBudget()): Scanned {
  const source = start.source ?? 'input', prefix = start.prefix ?? '', base = start.parent ?? null;
  const problems: Found[] = [];
  const recorded = new Map<Entity | null, Map<ProblemCode, Found>>();
  const report = (e: Entity | null, code: ProblemCode, blocking = BLOCKING.has(code)) => {
    let of = recorded.get(e);
    if (!of) recorded.set(e, (of = new Map()));
    const seen = of.get(code);
    if (seen) {
      if (blocking && !seen.blocking) { seen.blocking = true; e?.blocking.push(code); }
      return;
    }
    const f: Found = { entity: e, code, blocking };
    of.set(code, f);
    problems.push(f);
    if (e) { e.problems.push(code); if (blocking) e.blocking.push(code); }
  };

  let end = src.length;
  if (end > budget.bytes) {
    end = Math.max(0, budget.bytes);
    budget.overrun = true;
    report(null, 'limit');
  }
  budget.bytes -= end;

  const stack: Open[] = [];
  /** the multiparts whose delimiters are looked for, outermost first */
  const open: Open[] = [];
  /** the same by the hash of their boundary's bytes (`hashOf`), in the order opened; how many have each length, and
   * each last byte */
  const byHash = new Map<number, Open[]>();
  const lengths = new Uint8Array(MAX_BOUNDARY + 1), lasts = new Uint8Array(256);
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const openPush = (e: Open) => {
    open.push(e);
    const h = hashOf(new DataView(e.b!.buffer), e.b!, 0, e.b!.length);
    const list = byHash.get(h);
    if (list) list.push(e); else byHash.set(h, [e]);
    lengths[e.b!.length]!++;
    lasts[e.b![e.b!.length - 1]!]!++;
  };
  const openPop = () => {
    const f = open.pop()!;
    const h = hashOf(new DataView(f.b!.buffer), f.b!, 0, f.b!.length);
    const list = byHash.get(h)!;
    // stack order: the multipart closed last is the last of its list
    list.pop();
    if (!list.length) byHash.delete(h);
    lengths[f.b!.length]!--;
    lasts[f.b![f.b!.length - 1]!]!--;
  };
  /** the open multipart whose boundary is exactly `src[s, e)` (the innermost, should two share it), or null */
  const lookup = (s: number, e: number): Open | null => {
    const n = e - s;
    if (n < 1 || n > MAX_BOUNDARY || !lengths[n] || !lasts[src[e - 1]!]) return null;
    const list = byHash.get(hashOf(view, src, s, e));
    if (!list) return null;
    for (let j = list.length - 1; j >= 0; j--) {
      const b = list[j]!.b!;
      if (b.length !== n) continue;
      let i = 0;
      while (i < n && src[s + i] === b[i]) i++;
      if (i === n) return list[j]!;
    }
    return null;
  };
  /** whether the innermost entity's headers are still being read */
  let pending = false;

  const make = (parent: Entity | null, at: number, id: string, nestedRoot: boolean): Open => {
    budget.parts--;
    const depth = parent ? parent.depth + 1 : (base ? base.depth + 1 : 1);
    const nested = parent ? parent.nested + (nestedRoot ? 1 : 0) : (base ? base.nested : 0);
    return {
      id, source, parent: parent ?? base, depth, nested, root: !parent || nestedRoot, start: at, bodyStart: at, end: at,
      fields: [], headerEnded: false, type: 'text/plain', params: [], disposition: null, dispositionParams: [],
      encoding: 'identity', opaque: null, boundary: null, closed: false, children: [], message: null, problems: [],
      blocking: [], above: false, below: false, midPadding: false, k: stack.length, b: null, sealed: false,
    };
  };
  const push = (e: Open) => { e.k = stack.length; stack.push(e); };

  /** the innermost multipart's next child would pass the part limit: one opaque child for the rest of its body */
  const overflow = (f: Open, at: number) => {
    const blob = make(f, at, `${f.id}.${f.children.length + 1}`, false);
    blob.type = 'application/octet-stream';
    blob.opaque = 'limit';
    f.children.push(blob);
    f.sealed = true;
    openPop();
    report(blob, 'limit');
    push(blob);
  };

  /** the headers of the innermost entity end at `regionEnd`: what it is, and what is read next */
  const endHeaders = (e: Open, regionEnd: number) => {
    // an mbox `From ` line is skipped only as the input's first line, never in a payload or a nested message
    const hb = readHeaders(src, e.start, regionEnd, e.root, (c) => report(e, c), source === 'input' && e.start === 0 && !e.parent);
    e.fields = hb.fields;
    e.headerEnded = hb.ended;
    e.bodyStart = hb.ended ? hb.bodyStart : regionEnd;
    if (!hb.ended) report(e, 'no-header-end');
    interpret(e, (c, b) => report(e, c, b));
    const parent = e.parent;
    // IMAP's numbering: a nested message's multipart root has no number of its own, it is its message/rfc822
    // entity's; so a Problem's `part` names both, and problemsOf lists their problems together (one per code,
    // blocking when either's is): none is lost, and a blocking one on either stops the steps of both
    if (e.root && parent && parent.source === source && parent.message === e) e.id = isMultipart(e.type) ? parent.id : parent.id + '.1';
    pending = false;
    if (e.depth > MAX_DEPTH) { e.opaque = 'limit'; report(e, 'limit'); return; }
    if (e.opaque) return;
    if (isMultipart(e.type)) {
      const b = paramOf(e.params, 'boundary');
      let ok = b !== null && boundaryValid(b) && !e.boundaryEncoded;
      // only this source's ancestors: a decrypted payload may reuse the boundary of the message it came in. A child
      // boundary that starts with an ancestor's, or that an ancestor's is with `--` appended (outer `a--`, inner `a`: the
      // inner close line `--a--` is the outer delimiter to other parsers), is boundary-invalid
      for (let a: Entity | null = e.parent; ok && a && a.source === source; a = a.parent) {
        if (a.boundary !== null && (b!.startsWith(a.boundary) || a.boundary === b + '--')) ok = false;
      }
      if (!ok) { e.opaque = 'boundary-invalid'; report(e, 'boundary-invalid'); return; }
      e.boundary = b;
      e.b = new Uint8Array(b!.length);
      for (let i = 0; i < b!.length; i++) e.b[i] = b!.charCodeAt(i);
      openPush(e);
      return;
    }
    if (isNestedMessage(e.type)) {
      if (e.nested >= MAX_NESTED || budget.parts <= 0) { e.opaque = 'limit'; report(e, 'limit'); return; }
      const n = make(e, e.bodyStart, e.id + '.1', true);
      e.message = n;
      push(n);
      pending = true;
    }
  };

  /** a delimiter of `f` on the line [at, next) */
  const delimiter = (f: Open, close: boolean, at: number) => {
    while (pending) endHeaders(stack[stack.length - 1]!, at);
    const lb = at > 0 && src[at - 1] === 0x0a ? (at > 1 && src[at - 2] === 0x0d ? 2 : 1) : 0;
    const cut = at - lb;
    while (stack.length - 1 > f.k) closeEntity(stack.pop()!, cut);
    while (open.length && open[open.length - 1]!.k > f.k) openPop();
  };

  const closeEntity = (e: Open, at: number) => {
    // an entity begun past the delimiter's line break (an empty part, or a nested root at the end of an empty
    // message/rfc822 body) is the empty range at `at`, so it stays within its parent, which ends at `at` too
    if (e.start > at) e.start = at;
    e.end = at;
    if (e.bodyStart > e.end) e.bodyStart = e.end;
    if (e.boundary !== null && !e.closed && !e.sealed) report(e, 'boundary-missing-close');
  };

  /**
   * The open multipart whose delimiter the line [at, stop) is, and whether it is the close: the transport padding
   * stripped from its end once, then what follows `--` looked up as a boundary, else, when it ends in `--`, what
   * precedes those as a closed one (`lookup`: by length, then by hash, then byte by byte). A line longer than `--`,
   * 70 bytes and `--` (padding aside) is no delimiter. At most one open boundary can match a line: the open
   * multiparts are one chain of ancestors, and scan refuses a child boundary that starts with an ancestor's, or
   * one an ancestor's is with `--` appended; so the lookup's order is the old innermost-first loop's.
   */
  const match = (at: number, stop: number): [Open, boolean] | null => {
    let t = stop;
    while (t > at && (src[t - 1] === 0x20 || src[t - 1] === 0x09)) t--;
    const n = t - at - 2;
    if (n < 1 || n > MAX_BOUNDARY + 2) return null;
    const f = lookup(at + 2, t);
    if (f) return [f, false];
    if (n >= 3 && src[t - 1] === 0x2d && src[t - 2] === 0x2d) {
      const g = lookup(at + 2, t - 2);
      if (g) return [g, true];
    }
    return null;
  };

  const root = make(null, 0, prefix + '1', false);
  push(root);
  if (budget.parts < 0) {
    // the part budget was spent by the sources before this one
    root.opaque = 'limit';
    root.type = 'application/octet-stream';
    report(root, 'limit');
  } else pending = true;

  for (let pos = 0; pos < end;) {
    if (!pending && !open.length) break;
    let lf = src.indexOf(0x0a, pos);
    if (lf < 0 || lf >= end) lf = end;
    const next = lf < end ? lf + 1 : end;
    const stop = lf < end && lf > pos && src[lf - 1] === 0x0d ? lf - 1 : lf;
    if (open.length && stop - pos >= 2 && src[pos] === 0x2d && src[pos + 1] === 0x2d) {
      // a CR as the source's last byte, after a delimiter: a CRLF the end cut (`--b--\r`)
      const m = match(pos, lf === src.length && stop === lf && src[stop - 1] === 0x0d ? stop - 1 : stop);
      if (m) {
        const [f, close] = m;
        delimiter(f, close, pos);
        if (close) { f.closed = true; openPop(); }
        else if (budget.parts <= 0) overflow(f, next);
        else {
          const child = make(f, next, `${f.id}.${f.children.length + 1}`, false);
          f.children.push(child);
          push(child);
          pending = true;
        }
        pos = next;
        continue;
      }
    }
    if (pending && stop === pos) endHeaders(stack[stack.length - 1]!, next);
    pos = next;
  }
  while (pending) endHeaders(stack[stack.length - 1]!, end);
  while (stack.length) closeEntity(stack.pop()!, end);

  flags(root, base);
  for (const e of all(root)) { delete (e as Partial<Open>).k; delete (e as Partial<Open>).b; delete (e as Partial<Open>).sealed; delete (e as Partial<Interpreted>).boundaryEncoded; }
  return { root, problems, src, source, end };
}

interface Interpreted { boundaryEncoded?: boolean }

/** FNV-1a over `b[s, e)`, four bytes at a time (little-endian words, `v` viewing `b`'s buffer at its offset 0 =
 * `b[0]`), then the rest byte by byte: the same bytes give the same hash wherever they are */
function hashOf(v: DataView, b: Uint8Array, s: number, e: number): number {
  let h = 0x811c9dc5 | 0, i = s;
  for (; i + 4 <= e; i += 4) h = Math.imul(h ^ v.getUint32(i, true), 16777619);
  for (; i < e; i++) h = Math.imul(h ^ b[i]!, 16777619);
  return h >>> 0;
}

/** an entity's MIME fields read: type and parameters, disposition, transfer encoding, and their problems */
function interpret(e: Entity & Interpreted, report: (code: ProblemCode, blocking?: boolean) => void): void {
  const first = new Map<string, RawField>();
  for (const f of e.fields) {
    if (!MIME_FIELDS.has(f.name)) continue;
    if (first.has(f.name)) report('duplicate-field');
    else first.set(f.name, f);
  }
  const ctf = first.get('content-type');
  let ct: ParameterField;
  if (ctf) {
    const codes: ProblemCode[] = [];
    ct = contentType(ctf.value, (c) => codes.push(c));
    for (const c of codes) report(c, c === 'parameter-conflict' ? ct.conflicts.some((n) => STRUCTURAL.has(n)) : undefined);
  } else {
    const digest = e.parent && !e.root && e.parent.type === 'multipart/digest';
    ct = { value: digest ? 'message/rfc822' : 'text/plain', params: [], encoded: [], conflicts: [] };
  }
  e.type = ct.value;
  e.params = ct.params;
  e.boundaryEncoded = ct.encoded.includes('boundary') || ct.encoded.includes('boundary*');
  const cdf = first.get('content-disposition');
  if (cdf) {
    const codes: ProblemCode[] = [];
    // `attachment filename=x.html`: the leading token counts (an attachment, not a shown body), parameter-malformed
    const cd = parameterField(cdf.value, (c) => codes.push(c), true);
    for (const c of codes) report(c, c === 'parameter-conflict' ? false : undefined);
    e.disposition = cd.value === 'inline' ? 'inline' : cd.value === '' ? null : 'attachment';
    e.dispositionParams = cd.params;
  }
  const cte = first.get('content-transfer-encoding');
  const token = cte ? transferEncoding(cte.value, (c) => report(c)) : '7bit';
  const plain = token === '7bit' || token === '8bit' || token === 'binary';
  if (isMultipart(e.type) || e.type.startsWith('message/')) {
    if (!plain) report('encoding-on-multipart');
  } else if (token === 'base64') e.encoding = 'base64';
  else if (token === 'quoted-printable') e.encoding = 'quoted-printable';
  else if (!plain) { report('encoding-unknown'); e.opaque = 'encoding-unknown'; }
}

/** every entity of a tree, parents before children, nested messages included */
export function all(root: Entity): Entity[] {
  const out: Entity[] = [], stack = [root];
  while (stack.length) {
    const e = stack.pop()!;
    out.push(e);
    if (e.message) stack.push(e.message);
    for (let i = e.children.length - 1; i >= 0; i--) stack.push(e.children[i]!);
  }
  return out;
}

/** `above` and `below` of every entity, from their blocking problems */
function flags(root: Entity, base: Entity | null): void {
  const order = all(root);
  for (const e of order) e.above = e.blocking.length > 0 || (e.parent ? e.parent.above : false) || (e === root && !!base?.above);
  for (let i = order.length - 1; i >= 0; i--) {
    const e = order[i]!;
    let below = e.blocking.length > 0;
    for (const c of e.children) below ||= c.below;
    if (e.message) below ||= e.message.below;
    e.below = below;
  }
}
