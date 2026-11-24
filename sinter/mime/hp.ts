// Protected headers (docs/proposals/sinter-mail-mime.md, section 6; RFC 9788 and the Autocrypt draft's
// `protected-headers="v1"`): where they are read, which fields they replace, whom a reply goes to, which fields were
// confidential, and the legacy display parts that are not shown.
import type { Address, Field, Headers, Sources } from './types.js';
import type { Entity } from './scan.js';
import type { RawField } from './headers.js';
import type { RootInfo, Sig } from './steps.js';
import { paramOf } from './scan.js';
import { asciiLower } from './charset.js';
import { sameAddress } from './address.js';

export type Form = { form: 'hp'; hp: 'cipher' | 'clear' } | { form: 'v1' };

/** the protected-headers form a payload root carries: RFC 9788's `hp`, the older `protected-headers="v1"`, or null */
export function protectionForm(e: Entity | null): Form | null {
  if (!e) return null;
  const hp = asciiLower((paramOf(e.params, 'hp') ?? '').trim());
  if (hp === 'cipher' || hp === 'clear') return { form: 'hp', hp };
  return asciiLower((paramOf(e.params, 'protected-headers') ?? '').trim()) === 'v1' ? { form: 'v1' } : null;
}

/**
 * The older convention's legacy display part: in a multipart/mixed payload with `protected-headers="v1"` and
 * exactly two parts, the first, when it is text/plain or text/rfc822-headers with `protected-headers="v1"`.
 */
export function v1Display(P: Entity): Entity | null {
  if (P.type !== 'multipart/mixed' || P.boundary === null || P.children.length !== 2 || protectionForm(P)?.form !== 'v1') return null;
  const c = P.children[0]!;
  if (c.type !== 'text/plain' && c.type !== 'text/rfc822-headers') return null;
  return asciiLower((paramOf(c.params, 'protected-headers') ?? '').trim()) === 'v1' ? c : null;
}

/** a text without its legacy display: everything up to and including its first blank line; null when it has none */
export function legacyText(t: string): string | null {
  for (let i = 0; i < t.length;) {
    let lf = t.indexOf('\n', i);
    if (lf < 0) return null;
    let blank = true;
    for (let k = i; k < lf; k++) { const c = t.charCodeAt(k); if (c !== 0x20 && c !== 0x09 && c !== 0x0d) { blank = false; break; } }
    if (blank) return t.slice(lf + 1);
    i = lf + 1;
  }
  return null;
}

const FIELDS: [Field, string][] = [['subject', 'subject'], ['sender', 'sender'], ['replyTo', 'reply-to'], ['to', 'to'], ['cc', 'cc'],
  ['date', 'date'], ['messageId', 'message-id'], ['inReplyTo', 'in-reply-to'], ['references', 'references']];

/** structural fields (MIME-Version, Content-*) and HP-Outer are never protected header fields */
const structural = (name: string) => name === 'mime-version' || name.startsWith('content-') || name === 'hp-outer';

/** exactly one address, not null: its addr-spec; otherwise null */
export function single(from: readonly Address[]): string | null {
  return from.length === 1 && from[0]!.address !== null ? from[0]!.address : null;
}

/** whether a good signature over the payload's root has `address` among its signer */
export const signedBy = (sigs: readonly Sig[], address: string | null) =>
  address !== null && sigs.some((s) => s.status === 'good' && s.signer.some((x) => sameAddress(x, address)));

export interface Applied {
  headers: Headers;
  sources: Sources;
  reply: Address[];
  confidential: string[];
  /** the payload's From when protected headers apply and the payload has one, else null */
  protectedFrom: Address[] | null;
}

const OUTER = (): Sources => ({
  subject: 'outer', from: 'outer', sender: 'outer', replyTo: 'outer', to: 'outer', cc: 'outer', date: 'outer',
  messageId: 'outer', inReplyTo: 'outer', references: 'outer',
});

/**
 * The headers to show (section 6). `inner` is the payload root's Headers (headersOf its fields), read by the caller.
 * Protected headers apply when the root has a payload that counts (decrypted; or signed only, with a good verdict)
 * and carries a form. With `hp` the whole set comes from the payload (a field it lacks is empty); with v1 field by
 * field, Reply-To from the payload only. From is the payload's only with a good signature over the payload's root
 * whose signer includes it. Lists, Autocrypt and raw are always the outer ones.
 */
export function applyProtected(root: RootInfo, outerRoot: Entity, outer: Headers, inner: () => Headers): Applied {
  const P = root.payload;
  const form = protectionForm(P);
  const counts = root.encrypted || root.sigs.some((s) => s.status === 'good');
  if (!P || !form || !counts) {
    return { headers: outer, sources: OUTER(), reply: outer.replyTo.length ? outer.replyTo : outer.from, confidential: [], protectedFrom: null };
  }
  const ph = inner();
  const has = (name: string) => P.fields.some((f) => f.name === name);
  const headers: Headers = { ...outer };
  const sources = OUTER();
  const set = <F extends Field>(f: F) => { (headers as unknown as Record<string, unknown>)[f] = ph[f]; sources[f] = 'protected'; };
  for (const [f, name] of FIELDS) if (form.form === 'hp' || f === 'replyTo' || has(name)) set(f);
  const protectedFrom = has('from') ? ph.from : null;
  if (protectedFrom && signedBy(root.sigs, single(protectedFrom))) set('from');
  let reply: Address[];
  if (root.encrypted && ph.replyTo.length) reply = ph.replyTo;
  else if (root.encrypted && protectedFrom?.length) reply = protectedFrom;
  else reply = headers.replyTo.length ? headers.replyTo : headers.from;
  return { headers, sources, reply, confidential: root.encrypted ? confidential(P, outerRoot.fields, form) : [], protectedFrom };
}

/**
 * The header names the sender sent only encrypted (RFC 9788 4.3.1), from inside the payload: with hp="cipher", each
 * protected field no `HP-Outer` of the payload root matches by name and unfolded value; with hp="clear", none; with
 * v1, each protected field whose outer value differs or is absent.
 */
function confidential(P: Entity, outerFields: readonly RawField[], form: Form): string[] {
  if (form.form === 'hp' && form.hp === 'clear') return [];
  const out: string[] = [];
  let refouter: [string, string][] | null = null;
  if (form.form === 'hp') {
    refouter = [];
    for (const f of P.fields) {
      if (f.name !== 'hp-outer') continue;
      const colon = f.value.indexOf(':');
      if (colon <= 0) continue;
      refouter.push([asciiLower(f.value.slice(0, colon).trim()), f.value.slice(colon + 1).replace(/^[ \t]+/, '').trimEnd()]);
    }
  }
  for (const f of P.fields) {
    if (structural(f.name) || out.includes(f.name)) continue;
    const kept = refouter
      ? refouter.some(([n, v]) => n === f.name && v === f.value)
      : outerFields.some((o) => o.name === f.name && o.value === f.value);
    if (!kept) out.push(f.name);
  }
  return out;
}
