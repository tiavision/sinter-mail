// The MIME reader, behind `@tiavision/sinter-mail/mime` (docs/proposals/sinter-mail-mime.md, section 8): what
// mail.mime runs. An app that lists this package in `sinter({ lazy })` makes it load when a let first needs
// mail.mime; sinter/mime.ts imports it by that specifier, never by a relative path.
//
// `read` is one call's work: the input scanned (scan.ts), what to show chosen and the message assembled (show.ts),
// the steps and their results (crypto.ts, steps.ts), protected headers and the summary (hp.ts, protect.ts), the
// problems listed once each. This entry exports `read`, its options and the message's types, and the reference
// cutter `cutMessage` (cut.ts, behind mail.cut), nothing else: the rest is the reader's internals, imported by their
// own modules.
import type { Decrypted, Hole, Message, Problem, Verdict } from './types.js';
import { newBudget, scan, type Found } from './scan.js';
import { problem, reader } from './show.js';
import { newState, type CryptoState } from './steps.js';
import { rootMessage } from './protect.js';
import { annotate, match, place } from './holes.js';

/** mail.mime's options, validated and normalized by sinter/mime.ts */
export interface ReadOptions {
  prefer: 'html' | 'text';
  decrypted: Map<string, Decrypted>;
  verdicts: Map<string, Verdict[]>;
  open: string[];
  /** the input is a cut message: the bodies cut out of it, in the whole message's offsets */
  holes: Hole[];
}

/** the message of `bytes` under `options`: not frozen (mail.mime freezes it) */
export function read(bytes: Uint8Array, options: ReadOptions): Message {
  const budget = newBudget();
  // a cut message's limits are the whole message's: the bytes cut count against the budget
  const cuts = options.holes.length ? place(options.holes, bytes.length) : null;
  if (cuts) for (const c of cuts) budget.bytes -= c.length;
  const s = scan(bytes, { source: 'input', prefix: '' }, budget);
  const r = reader(new Map([['input', bytes]]), s.problems, options.prefer);
  let valid = true;
  if (options.holes.length) {
    valid = cuts !== null && match(bytes, s.root, cuts);
    // a hole the reader does not allow: the input may not read as the whole message would, so no step is offered
    if (!valid) problem(r, s.root, 'hole-mismatch', true);
    if (cuts) r.cuts = cuts;
  }
  const st = (r.crypto = newState(options, budget, s.root));
  const m = rootMessage(r, s.root);
  if (stale(st, options)) r.problems.push({ entity: null, code: 'stale-result', blocking: false });
  if (r.cuts) annotate(m, r.cuts);
  m.cut = options.holes.length ? (valid ? 'valid' : 'invalid') : null;
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
function problemsOf(found: readonly Found[]): Problem[] {
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

export { cutMessage, type CutMessage, type CutOptions } from './cut.js';
export type * from './types.js';
