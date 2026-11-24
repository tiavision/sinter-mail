// The MIME reader, behind `@tiavision/sinter-mail/mime` (docs/proposals/sinter-mail-mime.md, section 8): what
// mail.mime runs. An app that lists this package in `sinter({ lazy })` makes it load when a let first needs
// mail.mime; sinter/mime.ts imports it by that specifier, never by a relative path.
//
// `read` is one call's work: the input scanned (scan.ts), what to show chosen and the message assembled (show.ts),
// the steps and their results (crypto.ts, steps.ts), protected headers and the summary (hp.ts, protect.ts), the
// problems listed once each. The rest is the reader's internal API.
import type { Decrypted, Message, Problem, Verdict } from './types.js';
import { newBudget, scan, type Found } from './scan.js';
import { reader } from './show.js';
import { newState, type CryptoState } from './steps.js';
import { rootMessage } from './protect.js';

/** mail.mime's options, validated and normalized by sinter/mime.ts */
export interface ReadOptions {
  prefer: 'html' | 'text';
  decrypted: Map<string, Decrypted>;
  verdicts: Map<string, Verdict[]>;
  open: string[];
}

/** the message of `bytes` under `options`: not frozen (mail.mime freezes it) */
export function read(bytes: Uint8Array, options: ReadOptions): Message {
  const budget = newBudget();
  const s = scan(bytes, { source: 'input', prefix: '' }, budget);
  const r = reader(new Map([['input', bytes]]), s.problems, options.prefer);
  const st = (r.crypto = newState(options, budget, s.root));
  const m = rootMessage(r, s.root);
  if (stale(st, options)) r.problems.push({ entity: null, code: 'stale-result', blocking: false });
  m.problems = problemsOf(r.problems);
  return m;
}

/** whether a result or an `open` id matches no step (and no encrypted part) of this message: ignored, one problem */
function stale(st: CryptoState, o: ReadOptions): boolean {
  for (const k of o.decrypted.keys()) if (!st.decryptIds.has(k)) return true;
  for (const k of o.verdicts.keys()) if (!st.verifyIds.has(k)) return true;
  for (const k of o.open) if (!st.known.has(k)) return true;
  return false;
}

/** the problems as the message lists them: one per part and code, in the order found, blocking if any was (a nested
 * message's multipart root shares its message entity's id, scan.ts: their problems merge here, blocking kept) */
export function problemsOf(found: readonly Found[]): Problem[] {
  const out: Problem[] = [], at = new Map<string, Problem>();
  for (const f of found) {
    const part = f.entity ? f.entity.id : null;
    const key = `${part ?? ''}\0${f.code}`;
    const p = at.get(key);
    if (p) { p.blocking ||= f.blocking; continue; }
    const q: Problem = { code: f.code, part, blocking: f.blocking };
    at.set(key, q);
    out.push(q);
  }
  return out;
}

export { all, boundaryValid, isBlocking, isMultipart, isNestedMessage, newBudget, paramOf, scan, MAX_BOUNDARY, MAX_BYTES, MAX_DEPTH, MAX_NESTED, MAX_PARTS, MAX_PAYLOAD, MAX_STEPS } from './scan.js';
export type { Budget, Entity, Found, Opaque, ScanStart, Scanned } from './scan.js';
export { armorKind, attach, body, contentIdOf, flavor, headersOf, inline, message, problem, reader, relatedRoot, sameProtection, text, textPart, textQuiet, unprotected, walk } from './show.js';
export type { Ctx, Mode, Reader, Scope } from './show.js';
export { checkSigned, cryptoShape, encryptedFile, resolveCandidates, showEncrypted, showSigned, showText } from './crypto.js';
export { canOffer, combine, findBlocks, newState, refBytes, shownSigned, stateOf } from './steps.js';
export type { Block, CryptoState, RootInfo, Sig } from './steps.js';
export { applyProtected, legacyText, protectionForm, v1Display } from './hp.js';
export { rootMessage } from './protect.js';
export type { Shape } from './crypto.js';
