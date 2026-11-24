// `mail.mime(bytes, options)`: a whole message to its headers, parts, attachments and problems
// (docs/proposals/sinter-mail-mime.md, sections 1 and 2). This module validates the options and keeps the results,
// frozen (mime/cache.ts, `mail.mime.clear()` drops them); the reader itself is `@tiavision/sinter-mail/mime`, imported by that specifier and never by a
// relative path, so that an app listing the package in `sinter({ lazy })` loads the reader on demand (mail.mime is
// then a lazy helper: in a let, undefined until the reader has arrived).
//
// Pure: the same bytes and options give the same frozen, JSON-shaped message, with no globals beyond the language's
// and TextEncoder.
import { read } from '@tiavision/sinter-mail/mime';
import type { Decrypted, Message, MimeOptions, Verdict } from './mime/types.js';
import { cached, clearCache, sameOptions, type Options } from './mime/cache.js';

/**
 * The message `bytes` holds (a string is read as UTF-8), under `options`. The same bytes and options give the same
 * message, frozen at every depth. Invalid options throw a TypeError; results for steps the message does not have
 * are ignored (`stale-result`).
 */
export function mime(bytes: Uint8Array | string, options?: MimeOptions): Message {
  if (!(bytes instanceof Uint8Array) && typeof bytes !== 'string') fail(`the message is a Uint8Array or a string, not ${describe(bytes)}`);
  return last.get(bytes, optionsOf(options));
}

/** drops every message kept, and the plaintexts of the results they were read with (on lock or logout), as a
 * memo()'d helper's `.clear()` does; the next call reads again */
mime.clear = (): void => {
  last.clear();
  clearCache();
};

const fail = (msg: string): never => {
  throw new TypeError(`mail.mime: ${msg}`);
};

const describe = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'string' ? JSON.stringify(v) : typeof v);

const describeObject = (v: unknown) => (v instanceof Map ? 'a Map' : typeof v === 'object' && v !== null && !Array.isArray(v) ? 'an instance of a class' : describe(v));

const DECRYPTED = new Set(['ok', 'failed', 'no-key', 'locked', 'unsupported']);
const VERDICT = new Set(['good', 'bad', 'no-key', 'expired', 'revoked', 'unsupported']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

/** an object literal (or one made with Object.create(null)): not a Map, a class instance or an array, whose
 * entries Object.keys would not see */
const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function verdict(v: unknown, where: string): Verdict {
  if (!isRecord(v)) fail(`${where} is a verdict object, not ${describe(v)}`);
  const x = v as Record<string, unknown>;
  if (!VERDICT.has(x.status as string)) fail(`${where}: \`status\` is 'good', 'bad', 'no-key', 'expired', 'revoked' or 'unsupported', not ${JSON.stringify(x.status)}`);
  if (x.fingerprint !== undefined && typeof x.fingerprint !== 'string') fail(`${where}: \`fingerprint\` is a string`);
  if (x.created !== undefined && typeof x.created !== 'string') fail(`${where}: \`created\` is a string`);
  if (x.signer !== undefined && !(Array.isArray(x.signer) && x.signer.every((s) => typeof s === 'string'))) fail(`${where}: \`signer\` is an array of strings`);
  return v as unknown as Verdict;
}

/** the options validated; an invalid one throws at each call */
function optionsOf(options: MimeOptions | undefined): Options {
  if (options != null && !isRecord(options)) fail(`the options are an object, not ${describe(options)}`);
  const o: MimeOptions = options ?? {};
  const prefer = o.prefer ?? 'html';
  if (prefer !== 'html' && prefer !== 'text') fail(`\`prefer\` is 'html' or 'text', not ${JSON.stringify(prefer)}`);
  const decrypted: [string, Decrypted][] = [];
  if (o.decrypted != null) {
    if (!isPlain(o.decrypted)) fail(`\`decrypted\` is an object of results by step id (a plain one), not ${describeObject(o.decrypted)}`);
    for (const k of Object.keys(o.decrypted)) {
      const d = (o.decrypted as Record<string, unknown>)[k];
      const where = `\`decrypted[${JSON.stringify(k)}]\``;
      if (!isRecord(d)) fail(`${where} is a result object, not ${describe(d)}`);
      const x = d as Record<string, unknown>;
      if (!DECRYPTED.has(x.status as string)) fail(`${where}: \`status\` is 'ok', 'failed', 'no-key', 'locked' or 'unsupported', not ${JSON.stringify(x.status)}`);
      if (x.plaintext !== undefined && !(x.plaintext instanceof Uint8Array)) fail(`${where}: \`plaintext\` is a Uint8Array`);
      if (x.status === 'ok' && typeof x.integrity !== 'boolean') fail(`${where}: \`integrity\` is true or false with status 'ok'`);
      if (x.signatures !== undefined) {
        if (!Array.isArray(x.signatures)) fail(`${where}: \`signatures\` is an array of verdicts`);
        (x.signatures as unknown[]).forEach((v, i) => verdict(v, `${where}.signatures[${i}]`));
      }
      if (x.status === 'ok' && !(x.plaintext instanceof Uint8Array)) fail(`${where}: \`plaintext\` is required with status 'ok'`);
      decrypted.push([k, d as unknown as Decrypted]);
    }
  }
  const verdicts: [string, Verdict[]][] = [];
  if (o.verdicts != null) {
    if (!isPlain(o.verdicts)) fail(`\`verdicts\` is an object of verdict lists by step id (a plain one), not ${describeObject(o.verdicts)}`);
    for (const k of Object.keys(o.verdicts)) {
      const list = (o.verdicts as Record<string, unknown>)[k];
      const where = `\`verdicts[${JSON.stringify(k)}]\``;
      if (!Array.isArray(list)) fail(`${where} is an array of verdicts, not ${describe(list)}`);
      (list as unknown[]).forEach((v, i) => verdict(v, `${where}[${i}]`));
      verdicts.push([k, list as Verdict[]]);
    }
  }
  let open: string[] = [];
  if (o.open != null) {
    if (!Array.isArray(o.open) || !o.open.every((s) => typeof s === 'string')) fail(`\`open\` is an array of step ids, not ${describe(o.open)}`);
    // copied, never spread: a long array would overflow the call's arguments
    open = (o.open as string[]).slice();
  }
  return { prefer: prefer as 'html' | 'text', decrypted, verdicts, open };
}

/**
 * The message of the call before, when this one has the same input (by identity: a typed array is never compared
 * byte by byte) and options. A let is evaluated at every read, with a new options object each time; sinter's memo()
 * calls through for typed arrays. The state is in a closure.
 */
const last = (() => {
  let input: Uint8Array | string | undefined, opts: Options | undefined, value: Message | undefined;
  const get = (bytes: Uint8Array | string, o: Options): Message => {
    if (value && bytes === input && sameOptions(o, opts!)) return value;
    const v = cached(bytes, o, read);
    input = bytes; opts = o; value = v;
    return v;
  };
  const clear = () => { input = opts = value = undefined; };
  return { get, clear };
})();
