// mail.mime's cache (docs/proposals/sinter-mail-mime.md, section 1): the messages read, by input (identity) and
// options, bounded by count and by cost. Internal: sinter/mime.ts keeps its messages here, and the tests read its
// size; it is no export of the package (sinter.helpers.ts and the `./mime` entry do not re-export it). It imports no
// reader: the read function is mail.mime's, passed in, so this module goes wherever sinter/mime.ts goes.
import type { Decrypted, Message, Part, Verdict } from './types.js';
import type { ReadOptions } from './index.js';

/** the options as compared and read: `prefer` by value, the results entry by entry (key, and value by identity) */
export interface Options {
  prefer: 'html' | 'text';
  decrypted: [string, Decrypted][];
  verdicts: [string, Verdict[]][];
  open: string[];
}

const sameEntries = <T>(a: [string, T][], b: [string, T][]) => a.length === b.length && a.every(([k, v], i) => k === b[i]![0] && v === b[i]![1]);

export const sameOptions = (a: Options, b: Options) => a.prefer === b.prefer && sameEntries(a.decrypted, b.decrypted)
  && sameEntries(a.verdicts, b.verdicts) && a.open.length === b.open.length && a.open.every((s, i) => s === b.open[i]);

/** the cache's bounds: inputs kept, their total cost, option sets per input, and the cost of one entry beyond its
 * bytes, the message read from it and the options */
const MAX_INPUTS = 32, MAX_COST = 16 * 1024 * 1024, PER = 4, ENTRY = 4 * 1024;

/** what the message adds beyond its input: a constant per part, attachment, step and problem, and its texts' lengths
 * (two bytes a character), nested messages' included; cheap, never a serialization */
function messageCost(m: Message): number {
  let n = 256 * (m.attachments.length + m.steps.length + m.problems.length + m.calendar.length);
  for (const c of m.calendar) n += 2 * c.text.length;
  const stack: Part[] = [...m.parts];
  while (stack.length) {
    const p = stack.pop()!;
    n += 256;
    if (p.type === 'text' || p.type === 'report') n += 2 * p.text.length;
    else if (p.type === 'html') n += 2 * p.html.length + 64 * p.inline.length;
    else if (p.type === 'message') {
      n += 256 * (p.message.attachments.length + p.message.calendar.length);
      for (const c of p.message.calendar) n += 2 * c.text.length;
      stack.push(...p.message.parts);
    }
  }
  return n;
}

/** what one option set holds alive: the plaintexts of its results */
const optionsCost = (o: Options) => {
  let n = ENTRY;
  for (const [, d] of o.decrypted) if (d.plaintext instanceof Uint8Array) n += d.plaintext.byteLength;
  return n;
};

interface Kept { o: Options; v: Message; cost: number }

/**
 * Messages kept by input (identity) and options, in order of use: at most 32 inputs, and at most 16 MiB of cost,
 * which counts each input's length (bytes, or a string's length), per message kept a constant and an estimate of its
 * size (messageCost), and the byte length of every plaintext the kept options hold; at most 4 option sets per input.
 * The input just read is kept whatever its cost, so one large message still reads once per change of options. The
 * state is in a closure.
 */
const cache = (() => {
  const map = new Map<Uint8Array | string, Kept[]>();
  let total = 0;
  const costOf = (k: Uint8Array | string, of: Kept[]) => { let n = k.length; for (const x of of) n += x.cost; return n; };
  /** the message of `bytes` under `o`: kept, or read with `read` and frozen at every depth */
  const get = (bytes: Uint8Array | string, o: Options, read: (src: Uint8Array, o: ReadOptions) => Message): Message => {
    let of = map.get(bytes);
    if (of) { map.delete(bytes); map.set(bytes, of); } else { map.set(bytes, (of = [])); total += bytes.length; }
    const hit = of.find((x) => sameOptions(x.o, o));
    if (hit) return hit.v;
    const src = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    const ro: ReadOptions = { prefer: o.prefer, decrypted: new Map(o.decrypted), verdicts: new Map(o.verdicts), open: o.open.slice() };
    const v = frozen(read(src, ro));
    const kept: Kept = { o, v, cost: optionsCost(o) + messageCost(v) };
    of.unshift(kept);
    total += kept.cost;
    if (of.length > PER) total -= of.pop()!.cost;
    for (const [k, list] of map) {
      if ((total <= MAX_COST && map.size <= MAX_INPUTS) || k === bytes) break;
      map.delete(k);
      total -= costOf(k, list);
    }
    return v;
  };
  /** drops every message kept, and with them the options and plaintexts they hold */
  const clear = () => { map.clear(); total = 0; };
  /** for tests: how many inputs and option sets are kept, and their cost */
  const size = () => { let entries = 0; for (const of of map.values()) entries += of.length; return { inputs: map.size, entries, cost: total }; };
  return { get, clear, size };
})();

export const cached = cache.get;
export const clearCache = cache.clear;
export const cacheSize = cache.size;

/** `v` frozen at every depth (plain objects and arrays only: the message is JSON-shaped) */
function frozen<T>(v: T): T {
  const stack: unknown[] = [v];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x !== 'object' || x === null || Object.isFrozen(x)) continue;
    Object.freeze(x);
    for (const k of Object.keys(x)) stack.push((x as Record<string, unknown>)[k]);
  }
  return v;
}
