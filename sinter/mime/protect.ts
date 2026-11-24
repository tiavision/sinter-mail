// The root message assembled with its steps, protected headers and summary (docs/proposals/sinter-mail-mime.md,
// sections 6 and 7). Nested messages are show.ts's `message`: no steps, no protected headers of their own.
import type { Address, Message, Protection, Summary } from './types.js';
import type { Entity } from './scan.js';
import { headersOf, inline, problem, unprotected, walk, type Reader, type Scope } from './show.js';
import { resolveCandidates } from './crypto.js';
import { applyProtected, protectionForm, signedBy, single } from './hp.js';
import { stateOf, type RootInfo } from './steps.js';
import { sameAddress } from './address.js';

/** the message of the input's root: its walk, then the root decision of inline PGP, inline sets, headers, summary */
export function rootMessage(r: Reader, root: Entity): Message {
  const st = stateOf(r);
  const scope: Scope = { parts: [], attachments: [], calendar: [], html: [], of: new Map() };
  walk(r, root, scope, 'show', { related: null, report: false, protection: unprotected() });
  resolveCandidates(r, scope);
  cleartextRoot(r, scope);
  inline(r, scope);
  const outer = headersOf(root.fields, (c) => problem(r, root, c));
  const P = st.root.payload;
  const applied = applyProtected(st.root, root, outer, () => headersOf(P!.fields, (c) => problem(r, P, c)));
  const { summary, from } = summarize(scope, st.root, outer, applied.protectedFrom);
  const headers = applied.headers;
  const sources = applied.sources;
  if (from === 'protected') { headers.from = applied.protectedFrom!; sources.from = 'protected'; }
  else { headers.from = outer.from; sources.from = 'outer'; }
  return {
    type: 'message', headers, outer, sources, reply: applied.reply, confidential: applied.confidential, parts: scope.parts,
    attachments: scope.attachments, calendar: scope.calendar, steps: st.steps, summary, problems: [],
  };
}

/**
 * A root message whose only part shown is one text part that is wholly one cleartext-signed block (whitespace aside,
 * nothing before or after it), of the input or of the root's payload: that signature is over the payload's root,
 * for `summary.signed` and `summary.from` against the outer From, as an armored message in the same place is the
 * root's decrypt step (section 5). Only when the payload has no protected headers form: a cleartext signature covers
 * its text, never a header section, so it never makes protected headers apply, never binds a protected From and never
 * changes `reply`. Not when the part's label is no longer the block's (withdrawn) or a blocking problem is above it.
 * Any other cleartext block labels only its own part.
 */
function cleartextRoot(r: Reader, scope: Scope): void {
  const st = stateOf(r);
  for (const c of st.cleartexts) {
    if (c.scope !== scope || scope.parts.length !== 1 || scope.parts[0] !== c.part) continue;
    if (c.entity.above || c.part.protection.step !== c.sig.step || protectionForm(st.root.payload) !== null) continue;
    const src = c.entity.source;
    if (src === 'input' ? st.root.encrypted : !(st.root.encrypted && st.root.payload?.source === src)) continue;
    st.root.sigs.push(c.sig);
  }
  st.cleartexts.length = 0;
}

/**
 * Section 7's summary over the root message's parts and attachments, and which From is shown:
 * - encrypted: 'all' when a root decrypt step is done and everything shown came from it (none opened), 'some' when
 *   anything is encrypted or opened, else 'none';
 * - from, by the truth table, in order: nothing encrypted and nothing signed: null; the outer From, or the From to
 *   show, not exactly one non-null address: 'unknown'; a good signature over the payload's root whose signer
 *   includes the From to show (the protected one when the payload has one): 'matches', that From shown; a protected
 *   From whose address differs from the outer one: 'differs'; else 'unknown';
 * - signed: 'all' when a good root signature's signer includes the shown From and every part and attachment is
 *   good with that signer; 'some' when anything is good; else 'none'.
 */
function summarize(scope: Scope, root: RootInfo, outer: { from: Address[] }, protectedFrom: Address[] | null): { summary: Summary; from: 'protected' | 'outer' } {
  const items: Protection[] = [...scope.parts.map((p) => p.protection), ...scope.attachments.map((a) => a.protection)];
  const anyEncrypted = items.some((p) => p.encrypted || p.opened);
  const encrypted: Summary['encrypted'] = root.encrypted && items.every((p) => p.encrypted && !p.opened) ? 'all' : anyEncrypted ? 'some' : 'none';
  const outerFrom = single(outer.from);
  const show = protectedFrom ?? outer.from;
  let from: Summary['from'], shown: 'protected' | 'outer' = 'outer';
  if (!anyEncrypted && !root.encrypted && items.every((p) => p.signed === null)) from = null;
  else if (outerFrom === null || single(show) === null) from = 'unknown';
  else if (signedBy(root.sigs, single(show))) { from = 'matches'; if (protectedFrom) shown = 'protected'; }
  else if (protectedFrom && !sameAddress(single(protectedFrom), outerFrom)) from = 'differs';
  else from = 'unknown';
  const fromAddress = single(shown === 'protected' ? protectedFrom! : outer.from);
  const byFrom = (p: Protection) => p.signed === 'good' && fromAddress !== null && !!p.signer?.some((x) => sameAddress(x, fromAddress));
  const signed: Summary['signed'] = signedBy(root.sigs, fromAddress) && items.length > 0 && items.every(byFrom) ? 'all'
    : items.some((p) => p.signed === 'good') ? 'some' : 'none';
  return { summary: { encrypted, signed, from }, from: shown };
}
