// Choosing what to show, and the message assembled from an entity tree (docs/proposals/sinter-mail-mime.md,
// sections 2 and 3, "Choosing what to show"): parts in reading order, attachments, calendar parts, inline sets, and
// the headers of each message. Bodies are decoded here, once each, with their charset.
//
// The walk follows the tree's structure, whose depth scan.ts bounds (32 levels): a call per level, never more.
// Encrypted and signed structures go to crypto.ts, the seam wave 3 replaces.
import type { Address, Attachment, AttachmentKind, Calendar, Headers, Inline, Message, Part, ProblemCode, Protection, Ref, Sources } from './types.js';
import { addresses } from './address.js';
import { asciiLower, decodeText } from './charset.js';
import { base64Result, quotedPrintable, transferDecode, type Sink } from './decode.js';
import { parseDate } from './date.js';
import { filename } from './filename.js';
import { clean, messageIds, unstructured, type RawField } from './headers.js';
import { checkSigned, cryptoShape, encryptedFile, showEncrypted, showSigned, showText } from './crypto.js';
import { all, isMultipart, isNestedMessage, paramOf, type Entity, type Found } from './scan.js';
import type { CryptoState } from './steps.js';

/** what a walk reads from and reports to: one call's sources and problems */
export interface Reader {
  /** each source's bytes, by name ('input', or a decrypt step's id) */
  sources: Map<string, Uint8Array>;
  problems: Found[];
  prefer: 'html' | 'text';
  /** decoded texts, by entity, with the problems their decoding found (reported when the text is used) */
  texts: Map<Entity, { text: string; codes: ProblemCode[] }>;
  /** the steps' state (steps.ts): the options' results, the steps offered, the budget; made on first use */
  crypto?: CryptoState;
}

export function reader(sources: Map<string, Uint8Array>, problems: Found[], prefer: 'html' | 'text'): Reader {
  return { sources, problems, prefer, texts: new Map() };
}

/**
 * Records a problem found while showing (informational unless said). A blocking one is near crypto as a scanned one
 * is: in the entity's `blocking`, `above` for it and everything below it, `below` for it and every ancestor (through
 * `parent`, so from a decrypted payload to the encrypted entity it came from and on up).
 */
export function problem(r: Reader, e: Entity | null, code: ProblemCode, blocking = false): void {
  r.problems.push({ entity: e, code, blocking });
  if (e && !e.problems.includes(code)) e.problems.push(code);
  if (!e || !blocking) return;
  if (!e.blocking.includes(code)) e.blocking.push(code);
  for (const x of all(e)) x.above = true;
  for (let a: Entity | null = e; a && !a.below; a = a.parent) a.below = true;
}

/**
 * How a subtree is walked:
 * - `show`: text/plain and text/html parts that may be shown are parts;
 * - `unchosen`: a multipart/alternative's part not chosen: those are neither parts nor attachments, the rest are
 *   attachments (and calendar parts are still calendar);
 * - `related`: the parts of a multipart/related other than its root: attachments of kind `related`.
 */
export type Mode = 'show' | 'unchosen' | 'related';

export interface Ctx {
  /** the related parts of the multipart/related whose root this walk is in: an HTML part's own inline set */
  related: Attachment[] | null;
  /** the entity walked is a multipart/report's own part: a returned message is shown inline, whatever its
   * disposition. Only the report's direct children: every multipart below it (mixed, alternative, related) resets
   * it, so a message/rfc822 attachment deeper inside is an attachment by the usual rules */
  report: boolean;
  /** the protection of what this walk finds: set under a decryption or a signature (crypto.ts) */
  protection: Protection;
  /** in the payload of the root's done decrypt step, whose root has `hp`: `hp-legacy-display="1"` parts are legacy display */
  legacy?: boolean;
  /** the older convention's legacy display part (section 6), hidden */
  hide?: Entity | null;
}

/** one message being assembled: what its walk found, its own scope for Content-IDs */
export interface Scope {
  parts: Part[];
  attachments: Attachment[];
  calendar: Calendar[];
  /** each HTML part, with its own multipart/related's parts */
  html: { part: Part & { type: 'html' }; related: Attachment[] | null }[];
  /** the entity of each attachment */
  of: Map<Attachment, Entity>;
}

export const unprotected = (): Protection => ({ encrypted: false, signed: null });

export const sameProtection = (a: Protection, b: Protection) =>
  a.encrypted === b.encrypted && !!a.opened === !!b.opened && a.signed === b.signed && (a.step ?? null) === (b.step ?? null);

const OUTER = (): Sources => ({
  subject: 'outer', from: 'outer', sender: 'outer', replyTo: 'outer', to: 'outer', cc: 'outer', date: 'outer',
  messageId: 'outer', inReplyTo: 'outer', references: 'outer',
});

/** message/delivery-status and the like, shown as text */
const REPORT_TYPES = new Set(['message/delivery-status', 'message/disposition-notification', 'text/rfc822-headers',
  'message/global-delivery-status', 'message/global-disposition-notification', 'message/global-headers']);

/**
 * The message whose root is `root`: its headers, and what its walk shows. A nested message (`nested`) has no
 * steps, no protected headers and no problems of its own: the call's problems are all in the outermost message.
 */
export function message(r: Reader, root: Entity, protection: Protection = unprotected()): Message {
  const scope: Scope = { parts: [], attachments: [], calendar: [], html: [], of: new Map() };
  walk(r, root, scope, 'show', { related: null, report: false, protection });
  inline(r, scope);
  const headers = headersOf(root.fields, (c) => problem(r, root, c));
  return {
    type: 'message', headers, outer: headers, sources: OUTER(), reply: headers.replyTo.length ? headers.replyTo : headers.from,
    confidential: [], parts: scope.parts, attachments: scope.attachments, calendar: scope.calendar, steps: [],
    summary: { encrypted: 'none', signed: 'none', from: null }, problems: [],
  };
}

/** the entity and what is below it, into `scope` */
export function walk(r: Reader, e: Entity, scope: Scope, mode: Mode, ctx: Ctx): void {
  if (ctx.hide === e) return;
  if (e.opaque) {
    attach(r, e, scope, mode === 'related' ? 'related' : e.type.startsWith('message/') ? 'message' : 'file', ctx);
    return;
  }
  if (e.boundary !== null) {
    const shape = cryptoShape(r, e);
    if (shape === 'encrypted' || shape === 'exchange') return showEncrypted(r, e, shape, scope, mode, ctx);
    if (shape === 'signed') return showSigned(r, e, scope, mode, ctx);
    if (e.type === 'multipart/signed') checkSigned(r, e);
    if (e.type === 'multipart/alternative') return alternative(r, e, scope, mode, { ...ctx, report: false });
    if (e.type === 'multipart/related') return related(r, e, scope, mode, ctx);
    const sub = { ...ctx, report: e.type === 'multipart/report' };
    for (const c of e.children) walk(r, c, scope, mode, sub);
    return;
  }
  leaf(r, e, scope, mode, ctx);
}

function leaf(r: Reader, e: Entity, scope: Scope, mode: Mode, ctx: Ctx): void {
  const t = e.type;
  if (t === 'text/calendar') {
    const a = attach(r, e, scope, 'calendar', ctx);
    const method = paramOf(e.params, 'method');
    scope.calendar.push({ part: e.id, method: method === null ? null : clean(method), text: text(r, e), attachment: a.id });
    return;
  }
  if (mode === 'related') { attach(r, e, scope, 'related', ctx); return; }
  if (t === 'application/pgp-keys') { attach(r, e, scope, 'pgp-keys', ctx); return; }
  if (encryptedFile(e)) { attach(r, e, scope, 'encrypted', ctx); return; }
  const shown = mode === 'show' && e.disposition !== 'attachment';
  if (isNestedMessage(t) && e.message) {
    if (mode === 'show' && (e.disposition !== 'attachment' || ctx.report)) {
      const ref: Ref = { source: e.source, start: e.bodyStart, end: e.end, encoding: 'identity' };
      scope.parts.push({ id: e.id, contentType: t, protection: { ...ctx.protection }, type: 'message', message: message(r, e.message, ctx.protection), ref });
    } else attach(r, e, scope, 'message', ctx);
    return;
  }
  if (REPORT_TYPES.has(t)) {
    if (shown) scope.parts.push({ id: e.id, contentType: t, protection: { ...ctx.protection }, type: 'report', text: text(r, e) });
    else attach(r, e, scope, 'file', ctx);
    return;
  }
  if (t === 'text/plain' || t === 'text/html') {
    if (!named(e) && e.disposition !== 'attachment') {
      if (mode === 'unchosen') return;
      if (showText(r, e, scope, ctx)) return;
      scope.parts.push(textPart(r, e, ctx));
      if (t === 'text/html') scope.html.push({ part: scope.parts[scope.parts.length - 1] as Part & { type: 'html' }, related: ctx.related });
      return;
    }
  }
  attach(r, e, scope, 'file', ctx);
}

/** a text/plain or text/html part, decoded */
export function textPart(r: Reader, e: Entity, ctx: Ctx): Part {
  const base = { id: e.id, contentType: e.type, protection: { ...ctx.protection } };
  if (e.type === 'text/html') return { ...base, type: 'html', html: text(r, e), legacyDisplay: false, inline: [] };
  const flowed = asciiLower(paramOf(e.params, 'format') ?? '') === 'flowed';
  return { ...base, type: 'text', text: text(r, e), flowed, delsp: flowed && asciiLower(paramOf(e.params, 'delsp') ?? '') === 'yes' };
}

/** whether the entity has a filename (`filename*`, `filename`, `name*`, `name`) */
const named = (e: Entity) => paramOf(e.dispositionParams, 'filename') !== null || paramOf(e.params, 'name') !== null;

/**
 * multipart/alternative: the last part that can be shown, `prefer` choosing between an HTML and a text candidate; a
 * text candidate that is wholly one armored message or one cleartext-signed block wins whatever `prefer` says. The
 * others are walked `unchosen`.
 */
function alternative(r: Reader, e: Entity, scope: Scope, mode: Mode, ctx: Ctx): void {
  let chosen = -1;
  if (mode === 'show') {
    const kinds = e.children.map((c) => flavor(r, c));
    for (let i = kinds.length - 1; i >= 0 && chosen < 0; i--) {
      const c = e.children[i]!;
      if (kinds[i] === 'text' && c.boundary === null && armorKind(textQuiet(r, c)) !== null) chosen = i;
    }
    for (let i = kinds.length - 1; i >= 0 && chosen < 0; i--) if (kinds[i] === r.prefer) chosen = i;
    for (let i = kinds.length - 1; i >= 0 && chosen < 0; i--) if (kinds[i] !== null) chosen = i;
  }
  e.children.forEach((c, i) => walk(r, c, scope, i === chosen ? mode : mode === 'related' ? 'related' : 'unchosen', ctx));
}

/**
 * What a candidate of an alternative shows: `html`, `text`, `other` (something shown that is neither, such as an
 * encrypted part), or null (nothing to show). A multipart shows HTML when any part of it does.
 */
export function flavor(r: Reader, e: Entity): 'html' | 'text' | 'other' | null {
  if (e.opaque) return null;
  if (e.boundary !== null) {
    const shape = cryptoShape(r, e);
    if (shape === 'encrypted' || shape === 'exchange') return 'other';
    if (shape === 'signed') return e.children[0] ? flavor(r, e.children[0]) : null;
    if (e.type === 'multipart/related') { const root = relatedRoot(e); return root ? flavor(r, root) : null; }
    let best: 'text' | 'other' | null = null;
    for (const c of e.children) {
      const f = flavor(r, c);
      if (f === 'html') return 'html';
      if (f === 'text') best = 'text';
      else if (f && !best) best = f;
    }
    return best;
  }
  if (e.disposition === 'attachment' || named(e)) return null;
  return e.type === 'text/html' ? 'html' : e.type === 'text/plain' ? 'text' : null;
}

/** a multipart/related's root: the part whose Content-ID is its `start`, else the first */
export function relatedRoot(e: Entity): Entity | null {
  const start = paramOf(e.params, 'start');
  if (start !== null) {
    const id = stripAngles(start);
    for (const c of e.children) if (contentIdOf(c) === id) return c;
  }
  return e.children[0] ?? null;
}

/** multipart/related: its root walked as the rest of the message is; every other part an attachment of kind related */
function related(r: Reader, e: Entity, scope: Scope, mode: Mode, ctx: Ctx): void {
  const root = relatedRoot(e);
  const own: Attachment[] = [];
  const sub: Ctx = { ...ctx, related: own, report: false };
  for (const c of e.children) walk(r, c, scope, c === root ? mode : 'related', sub);
}

/**
 * An attachment for the entity. Its Ref is the whole entity, headers included, only for a multipart (opaque past a
 * limit or by its boundary, or an encrypted structure) and for the blob that collects the rest of a multipart past
 * the part limit (which has no headers: its body is the whole of it); any other entity, a leaf or a message/rfc822
 * past a limit included, is its body with its transfer encoding, as every attachment's is.
 */
export function attach(r: Reader, e: Entity, scope: Scope, kind: AttachmentKind, ctx: Ctx): Attachment {
  const names = filename(e.dispositionParams, e.params, (c) => problem(r, e, c));
  const whole = (e.opaque !== null && isMultipart(e.type)) || (e.boundary !== null && kind === 'encrypted');
  const ref: Ref = whole ? { source: e.source, start: e.start, end: e.end, encoding: 'identity' }
    : { source: e.source, start: e.bodyStart, end: e.end, encoding: e.encoding };
  const a: Attachment = {
    id: e.id, filename: names.filename, originalFilename: names.originalFilename, contentType: e.type, disposition: e.disposition,
    kind, contentId: contentIdOf(e), size: ref.encoding === 'identity' ? ref.end - ref.start : body(r, e).length, ref,
    protection: { ...ctx.protection },
  };
  scope.attachments.push(a);
  scope.of.set(a, e);
  if (kind === 'related' && ctx.related) ctx.related.push(a);
  return a;
}

/** the entity's body with its transfer encoding undone; base64 padding mid-stream is recorded on the entity */
export function body(r: Reader, e: Entity, sink: Sink = (c) => problem(r, e, c)): Uint8Array {
  const src = r.sources.get(e.source)!;
  if (e.encoding === 'base64') {
    const b = base64Result(src, e.bodyStart, e.end, sink);
    if (b.midPadding) e.midPadding = true;
    return b.bytes;
  }
  if (e.encoding === 'quoted-printable') return quotedPrintable(src, e.bodyStart, e.end, sink);
  return transferDecode(src, e.bodyStart, e.end, 'identity');
}

/** the entity's body as text, by its charset (missing: UTF-8), without reporting what decoding found */
export function textQuiet(r: Reader, e: Entity): string {
  let t = r.texts.get(e);
  if (!t) {
    const codes: ProblemCode[] = [];
    const sink: Sink = (c) => { if (!codes.includes(c)) codes.push(c); };
    t = { text: decodeText(body(r, e, sink), paramOf(e.params, 'charset'), sink), codes };
    r.texts.set(e, t);
  }
  return t.text;
}

/** the entity's body as text, its decoding's problems reported */
export function text(r: Reader, e: Entity): string {
  const s = textQuiet(r, e);
  for (const c of r.texts.get(e)!.codes) problem(r, e, c);
  return s;
}

const stripAngles = (s: string) => {
  let t = clean(s).trim();
  if (t.startsWith('<')) t = t.slice(1);
  if (t.endsWith('>')) t = t.slice(0, -1);
  return t.trim();
};

/** the entity's Content-ID, angle brackets stripped, or null */
export function contentIdOf(e: Entity): string | null {
  const f = e.fields.find((x) => x.name === 'content-id');
  if (!f) return null;
  const id = messageIds(f.value)[0] ?? stripAngles(f.value);
  return id || null;
}

/**
 * Each HTML part's inline set (section 2): the related parts of its own multipart/related, plus the attachments
 * elsewhere in the message whose Content-ID is unique in it and not among the first; only those with the part's
 * protection. A Content-ID twice in a scope resolves to nothing there (`content-id-duplicate`).
 */
export function inline(r: Reader, scope: Scope): void {
  const counts = new Map<string, number>();
  for (const a of scope.attachments) if (a.contentId !== null) counts.set(a.contentId, (counts.get(a.contentId) ?? 0) + 1);
  const reported = new Set<string>();
  const dup = (a: Attachment) => {
    if (reported.has(a.id)) return;
    reported.add(a.id);
    problem(r, scope.of.get(a) ?? null, 'content-id-duplicate');
  };
  const seen = new Set<string>();
  for (const a of scope.attachments) {
    if (a.contentId === null) continue;
    if (seen.has(a.contentId)) dup(a);
    seen.add(a.contentId);
  }
  // the set depends only on the part's protection and its multipart/related: parts that share both share one
  // frozen array, built once, so many HTML parts beside many Content-IDs cost one set each, not one per part
  const sets = new Map<Attachment[] | null, Map<string, Inline[]>>();
  for (const { part, related } of scope.html) {
    let byProtection = sets.get(related);
    if (!byProtection) sets.set(related, (byProtection = new Map()));
    const key = protectionKey(part.protection);
    let out = byProtection.get(key);
    if (!out) byProtection.set(key, (out = inlineSet(scope, part.protection, related, counts, dup)));
    part.inline = out;
  }
}

/** sameProtection's fields, as a key */
const protectionKey = (p: Protection) => `${p.encrypted ? 1 : 0}${p.opened ? 1 : 0}${p.signed ?? ''}\0${p.step ?? ''}`;

/** one inline set (see `inline`), frozen */
function inlineSet(scope: Scope, protection: Protection, related: Attachment[] | null, counts: Map<string, number>, dup: (a: Attachment) => void): Inline[] {
  const out: Inline[] = [], own = new Set<string>();
  const mine = new Set<Attachment>(related ?? []);
  if (related) {
    const local = new Map<string, number>();
    for (const a of related) if (a.contentId !== null) local.set(a.contentId, (local.get(a.contentId) ?? 0) + 1);
    for (const a of related) {
      if (a.contentId === null) continue;
      const again = own.has(a.contentId);
      own.add(a.contentId);
      if (local.get(a.contentId)! > 1) { if (again) dup(a); continue; }
      if (sameProtection(a.protection, protection)) out.push(Object.freeze({ contentId: a.contentId, attachment: a.id }));
    }
  }
  for (const a of scope.attachments) {
    if (a.contentId === null || own.has(a.contentId) || counts.get(a.contentId)! > 1 || mine.has(a)) continue;
    if (sameProtection(a.protection, protection)) out.push(Object.freeze({ contentId: a.contentId, attachment: a.id }));
  }
  return Object.freeze(out) as Inline[];
}

/** the armor a text is wholly made of (whitespace aside): one armored message, one cleartext-signed block, or null */
export function armorKind(text: string): 'message' | 'signed' | null {
  // most texts are not armor: nothing is split for them
  if (!text.trimStart().startsWith('-----BEGIN PGP ')) return null;
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const head = lines[0]!.trimEnd(), tail = lines[lines.length - 1]!.trimEnd();
  const count = (l: string) => { let n = 0; for (const x of lines) if (x.trimEnd() === l) n++; return n; };
  if (head === '-----BEGIN PGP MESSAGE-----' && tail === '-----END PGP MESSAGE-----'
    && count(head) === 1 && count(tail) === 1) return 'message';
  if (head === '-----BEGIN PGP SIGNED MESSAGE-----' && tail === '-----END PGP SIGNATURE-----'
    && count(head) === 1 && count('-----BEGIN PGP SIGNATURE-----') === 1 && count(tail) === 1) return 'signed';
  return null;
}

// --- headers ---

const LIST = new Map([['list-id', 'List-Id'], ['list-unsubscribe', 'List-Unsubscribe'], ['list-unsubscribe-post', 'List-Unsubscribe-Post']]);

/**
 * A message's Headers from its root's fields: a repeated From adds its addresses, a repeated Sender, Subject or
 * Date counts the first (`duplicate-header`); the other fields count their first. `raw` is every field, unfolded,
 * not decoded, with its value `clean`ed (controls removed: a raw value is still never a way into a reply's header).
 */
export function headersOf(fields: readonly RawField[], sink: Sink): Headers {
  const firsts = new Map<string, RawField>(), count = new Map<string, number>();
  for (const f of fields) {
    count.set(f.name, (count.get(f.name) ?? 0) + 1);
    if (!firsts.has(f.name)) firsts.set(f.name, f);
  }
  for (const n of ['from', 'sender', 'subject', 'date']) if ((count.get(n) ?? 0) > 1) sink('duplicate-header');
  const value = (n: string) => firsts.get(n)?.value ?? null;
  const list = (n: string): Address[] => { const v = value(n); return v === null ? [] : addresses(v, sink); };
  const from: Address[] = [];
  for (const f of fields) if (f.name === 'from') from.push(...addresses(f.value, sink));
  const subject = value('subject'), date = value('date'), id = value('message-id');
  return {
    subject: subject === null ? null : unstructured(subject, sink),
    from, sender: list('sender'), replyTo: list('reply-to'), to: list('to'), cc: list('cc'),
    date: date === null ? null : parseDate(date),
    messageId: id === null ? null : messageIds(id)[0] ?? null,
    inReplyTo: messageIds(value('in-reply-to') ?? ''), references: messageIds(value('references') ?? ''),
    list: fields.filter((f) => LIST.has(f.name)).map((f) => [LIST.get(f.name)!, clean(f.value)] as [string, string]),
    autocrypt: fields.filter((f) => f.name === 'autocrypt').map((f) => clean(f.value)),
    raw: fields.map((f) => [f.name, clean(f.value)] as [string, string]),
  };
}
