// `mail.cut(raw, options)`: the reference cutter (docs/mail.md, "Large attachments: cut messages"). A server (or a
// test) cuts the large leaf bodies out of a whole message; the reader reads the result with the `holes` it returns.
// It follows the reader's own rules, scan.ts's reading and holes.ts's leafCut, so mail.mime reads what it makes as
// 'valid'; a port to another language may use any parser, since the reader checks every hole again.
import type { Hole } from './types.js';
import { all, newBudget, scan } from './scan.js';
import { leafCut } from './holes.js';
import { cuttable, transferDecode } from './decode.js';
import { cryptoShape } from './crypto.js';
import { reader } from './show.js';
import type { Entity } from './scan.js';

export interface CutOptions {
  /** a body longer than this (encoded bytes) is cut; default 64 KiB */
  over?: number;
  /** the same for a part of a multipart/related (an inline image); default 512 KiB */
  relatedOver?: number;
  /** at most this many holes, the largest bodies first; default 32 */
  max?: number;
  /** also cut the ciphertext the reader decrypts without being asked (the root's): default false, since the app
   * then fetches the whole message at once anyway; true for an app that shows a placeholder before the download */
  rootCiphertext?: boolean;
}

export interface CutMessage {
  /** the message without the cut bodies */
  raw: Uint8Array;
  /** where they were, for mail.mime's `holes` */
  holes: Hole[];
}

/**
 * `raw` with the bodies of its large leaf parts cut out. A body is cut when the reader allows its leaf to be
 * (leafCut: not text/*, message/*, multipart/* or a PGP control part, its headers ended, not opaque), nothing near
 * it is malformed (no blocking problem in it or above it), its bytes pass `cuttable`, and it is longer than `over`
 * (`relatedOver` in a multipart/related). The input is never changed.
 */
export function cutMessage(raw: Uint8Array, options: Required<CutOptions>): CutMessage {
  const s = scan(raw, { source: 'input', prefix: '' }, newBudget());
  const skip = options.rootCiphertext ? new Set<Entity>() : rootCiphertext(raw, s.root, s.problems);
  const chosen = all(s.root).filter((e) => {
    if (!leafCut(e) || e.above || e.below || skip.has(e)) return false;
    const limit = e.parent?.type === 'multipart/related' ? options.relatedOver : options.over;
    return e.end - e.bodyStart > limit && cuttable(raw, e.bodyStart, e.end);
  });
  chosen.sort((a, b) => b.end - b.bodyStart - (a.end - a.bodyStart) || a.bodyStart - b.bodyStart);
  const kept = chosen.slice(0, options.max).sort((a, b) => a.bodyStart - b.bodyStart);
  let length = raw.length;
  for (const e of kept) length -= e.end - e.bodyStart;
  const out = new Uint8Array(length);
  const holes: Hole[] = [];
  let from = 0, n = 0;
  for (const e of kept) {
    out.set(raw.subarray(from, e.bodyStart), n);
    n += e.bodyStart - from;
    holes.push({ start: e.bodyStart, end: e.end, size: transferDecode(raw, e.bodyStart, e.end, e.encoding).length });
    from = e.end;
  }
  out.set(raw.subarray(from), n);
  return { raw: out, holes };
}

/**
 * The leaves of the encrypted structures the reader decrypts without being asked: the root's, when it is a PGP/MIME
 * encrypted structure or Exchange's rewrite of one, or the first part of a root multipart/signed (sign over
 * encrypt). Cutting their ciphertext saves nothing: the cut message has nothing to show, and the app fetches the
 * whole message at once to decrypt it. Encrypted structures anywhere else open only on request, and are cut like
 * any attachment.
 */
function rootCiphertext(raw: Uint8Array, root: Entity, problems: Parameters<typeof reader>[1]): Set<Entity> {
  const r = reader(new Map([['input', raw]]), problems.slice(), 'html');
  const roots = [root];
  if (cryptoShape(r, root) === 'signed' && root.children[0]) roots.push(root.children[0]);
  const out = new Set<Entity>();
  for (const e of roots) {
    const shape = cryptoShape(r, e);
    if (shape === 'encrypted' || shape === 'exchange') for (const x of all(e)) out.add(x);
  }
  return out;
}
