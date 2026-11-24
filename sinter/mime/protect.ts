// The root message assembled with its steps, protected headers and summary (docs/proposals/sinter-mail-mime.md,
// sections 6 and 7). Nested messages are show.ts's `message`: no steps, no protected headers of their own; their
// summary is summary.ts's, as the root's is.
import type { Message } from './types.js';
import type { Entity } from './scan.js';
import { headersOf, inline, problem, unprotected, walk, type Reader, type Scope } from './show.js';
import { resolveCandidates } from './crypto.js';
import { applyProtected, protectionForm } from './hp.js';
import { stateOf } from './steps.js';
import { protections, summarize } from './summary.js';

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
  const { summary, from } = summarize(protections(scope.parts, scope.attachments), st.root, outer, applied.protectedFrom);
  const headers = applied.headers;
  const sources = applied.sources;
  if (from === 'protected') { headers.from = applied.protectedFrom!; sources.from = 'protected'; }
  else { headers.from = outer.from; sources.from = 'outer'; }
  return {
    type: 'message', headers, outer, sources, reply: applied.reply, confidential: applied.confidential, hpOuter: applied.hpOuter, parts: scope.parts,
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
