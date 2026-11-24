// `mail.cut(raw, options)`: the reference cutter (docs/mail.md, "Large attachments: cut messages"). A server (or a
// test) cuts the large leaf bodies out of a whole message; the reader reads the result with the `holes` it returns.
// It follows the reader's own rules, scan.ts's reading and holes.ts's leafCut, so mail.mime reads what it makes as
// 'valid'; a port to another language may use any parser, since the reader checks every hole again.
import type { Hole } from './types.js';
import { all, newBudget, scan } from './scan.js';
import { leafCut } from './holes.js';
import { cuttable, transferDecode } from './decode.js';

export interface CutOptions {
  /** a body longer than this (encoded bytes) is cut; default 64 KiB */
  over?: number;
  /** the same for a part of a multipart/related (an inline image); default 512 KiB */
  relatedOver?: number;
  /** at most this many holes, the largest bodies first; default 32 */
  max?: number;
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
  const chosen = all(s.root).filter((e) => {
    if (!leafCut(e) || e.above || e.below) return false;
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
