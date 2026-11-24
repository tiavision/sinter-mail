// Section 7's summary (docs/proposals/sinter-mail-mime.md): over a message's parts and attachments, nested messages'
// included, and which From is shown. The root message's comes with its steps' signatures (protect.ts); a nested
// message has no steps of its own, and its summary is decided by the same rules with none.
import type { Address, Message, Protection, Summary } from './types.js';
import type { RootInfo } from './steps.js';
import { rootSignedBy, single } from './hp.js';
import { sameAddress } from './address.js';

/** what a nested message (or a root without steps) counts on: no payload, nothing decrypted as its own, no signature
 * over its root */
export const NO_ROOT = (): RootInfo => ({ payload: null, encrypted: false, sigs: [], decrypts: 0 });

/** the protections of the parts and attachments, and of every nested message's, at any depth */
export function protections(parts: readonly Message['parts'][number][], attachments: readonly Message['attachments'][number][]): Protection[] {
  const out: Protection[] = attachments.map((a) => a.protection);
  const stack = [...parts];
  while (stack.length) {
    const p = stack.pop()!;
    out.push(p.protection);
    if (p.type === 'message') {
      for (const a of p.message.attachments) out.push(a.protection);
      stack.push(...p.message.parts);
    }
  }
  return out;
}

/**
 * The summary over `items`, and which From is shown:
 * - encrypted: 'all' when a root decrypt step is done and everything shown came from it (none opened), 'some' when
 *   anything is encrypted or opened, else 'none';
 * - from, by the truth table, in order: nothing encrypted and nothing signed: null; the outer From, or the From to
 *   show, not exactly one non-null address: 'unknown'; a good signature over the payload's root whose signer
 *   includes the From to show (the protected one when the payload has one): 'matches', that From shown; a protected
 *   From whose address differs from the outer one: 'differs'; else 'unknown';
 * - signed: 'all' when a good root signature's signer includes the shown From and every part and attachment is
 *   good with that signer; 'some' when anything is good; else 'none'.
 * An opened part (anywhere, in a nested message too) is never the root's: it makes encrypted 'some', and it is
 * never a signature over the payload's root.
 */
export function summarize(items: readonly Protection[], root: RootInfo, outer: { from: Address[] }, protectedFrom: Address[] | null): { summary: Summary; from: 'protected' | 'outer' } {
  const anyEncrypted = items.some((p) => p.encrypted || p.opened);
  const encrypted: Summary['encrypted'] = root.encrypted && items.every((p) => p.encrypted && !p.opened) ? 'all' : anyEncrypted ? 'some' : 'none';
  const outerFrom = single(outer.from);
  const show = protectedFrom ?? outer.from;
  let from: Summary['from'], shown: 'protected' | 'outer' = 'outer';
  if (!anyEncrypted && !root.encrypted && items.every((p) => p.signed === null)) from = null;
  else if (outerFrom === null || single(show) === null) from = 'unknown';
  else if (rootSignedBy(root.sigs, single(show))) { from = 'matches'; if (protectedFrom) shown = 'protected'; }
  else if (protectedFrom && !sameAddress(single(protectedFrom), outerFrom)) from = 'differs';
  else from = 'unknown';
  const fromAddress = single(shown === 'protected' ? protectedFrom! : outer.from);
  const byFrom = (p: Protection) => p.signed === 'good' && fromAddress !== null && !!p.signer?.some((x) => sameAddress(x, fromAddress));
  const signed: Summary['signed'] = rootSignedBy(root.sigs, fromAddress) && items.length > 0 && items.every(byFrom) ? 'all'
    : items.some((p) => p.signed === 'good') ? 'some' : 'none';
  return { summary: { encrypted, signed, from }, from: shown };
}
