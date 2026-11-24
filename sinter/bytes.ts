// `mail.bytes(bytes, ref, options)` and `mail.imageType(bytes)` (docs/proposals/sinter-mail-mime.md, sections 1
// and 2): the bytes a message's Ref names, and an image's type by its magic number. This module imports only the
// transfer decoders and the magic numbers, relatively, never the reader: both stay ordinary helpers when an app
// makes the package lazy. Pure, with no globals beyond the language's and TextEncoder.
import { canonicalize, copy, cuttable, transferDecode } from './mime/decode.js';
import { imageType as magic } from './mime/magic.js';
import type { BytesOptions, ImageType, Ref } from './mime/types.js';

const fail = (name: string, msg: string): never => {
  throw new TypeError(`mail.${name}: ${msg}`);
};

const ENCODINGS = new Set(['base64', 'quoted-printable', 'identity']);
const offset = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** a string's UTF-8, the last one kept: an action reads many refs of one message (the state is in a closure) */
const utf8 = (() => {
  let text: string | undefined, bytes: Uint8Array | undefined;
  return (s: string): Uint8Array => {
    if (s !== text || !bytes) { text = s; bytes = new TextEncoder().encode(s); }
    return bytes;
  };
})();

/**
 * The bytes `ref` names: its source (the input, a string read as UTF-8, or the plaintext of the decrypt step it
 * names, from `options.decrypted`), the range `[start, end)`, its transfer encoding undone, then `slice` applied to
 * the decoded bytes, then with `canonical` every bare LF made CRLF. A new array over its own ArrayBuffer each call
 * (`new Blob([mail.bytes(…)])` type-checks as it is). A Ref with `missing` (bytes cut out of the input) is read
 * from `options.fetched`, its range of the whole message (see `filled`). A TypeError for a Ref outside its source,
 * whose source step has no `ok` plaintext, or with `missing` and no valid `fetched`.
 */
export function bytes(input: Uint8Array | string, ref: Ref, options?: BytesOptions): Uint8Array<ArrayBuffer> {
  if (!(input instanceof Uint8Array) && typeof input !== 'string') fail('bytes', 'the message is a Uint8Array or a string');
  if (typeof ref !== 'object' || ref === null) fail('bytes', 'the ref is a Ref from the message');
  const { source, start, end, encoding, canonical, slice } = ref;
  if (typeof source !== 'string') fail('bytes', '`ref.source` is a string');
  if (!offset(start) || !offset(end) || start > end) fail('bytes', `\`ref.start\` and \`ref.end\` are offsets with start <= end, not ${JSON.stringify([start, end])}`);
  if (!ENCODINGS.has(encoding)) fail('bytes', `\`ref.encoding\` is 'base64', 'quoted-printable' or 'identity', not ${JSON.stringify(encoding)}`);
  if (canonical !== undefined && canonical !== true) fail('bytes', '`ref.canonical` is true or absent');
  let src: Uint8Array;
  if (source === 'input') {
    src = typeof input === 'string' ? utf8(input) : input;
  } else {
    const d = options?.decrypted;
    const r = d != null && typeof d === 'object' && Object.prototype.hasOwnProperty.call(d, source) ? d[source] : undefined;
    if (!r || r.status !== 'ok' || !(r.plaintext instanceof Uint8Array)) fail('bytes', `step ${JSON.stringify(source)} has no 'ok' plaintext in \`decrypted\``);
    src = r!.plaintext!;
  }
  if (end > src.length) fail('bytes', `the ref ends at ${end}, past its source's ${src.length} bytes`);
  let from = start, to = end;
  if (ref.missing !== undefined) {
    src = filled(src, ref, options?.fetched);
    from = 0;
    to = src.length;
  }
  let out = transferDecode(src, from, to, encoding);
  if (slice !== undefined) {
    if (!Array.isArray(slice) || slice.length !== 2 || !offset(slice[0]) || !offset(slice[1]) || slice[0] > slice[1] || slice[1] > out.length) {
      fail('bytes', `\`ref.slice\` is [start, end] within the ${out.length} decoded bytes, not ${JSON.stringify(slice)}`);
    }
    out = copy(out, slice[0], slice[1]);
  }
  return canonical ? canonicalize(out) : out;
}

/**
 * The bytes of a Ref with `missing`: those the app fetched for its range of the whole message, checked against the
 * input (every byte outside the gaps is the input's own) and against the rule the reader's cut relies on: no line in
 * a gap starts with `--` (a line starting at the gap, or after a CR or an LF in it, under any reading of line ends),
 * and a gap does not end with a CR (which would join the delimiter's line break). A TypeError otherwise: the whole
 * message may not read as the cut one did, so read the whole message instead.
 */
function filled(src: Uint8Array, ref: Ref, fetched: unknown): Uint8Array {
  const m = ref.missing!;
  if (typeof m !== 'object' || m === null || !offset(m.start) || !offset(m.end) || m.start > m.end || !Array.isArray(m.gaps)) {
    fail('bytes', '`ref.missing` is { start, end, gaps } from the message');
  }
  if (!(fetched instanceof Uint8Array)) {
    fail('bytes', `the ref's bytes were cut out of the message: fetch bytes ${m.start} to ${m.end} of the whole message and pass them as \`fetched\``);
  }
  const f = fetched as Uint8Array;
  if (f.length !== m.end - m.start) fail('bytes', `\`fetched\` is the ${m.end - m.start} bytes of the ref's range, not ${f.length}`);
  let i = 0, j = ref.start;
  const same = (n: number) => {
    for (let k = 0; k < n; k++) if (f[i + k] !== src[j + k]) fail('bytes', '`fetched` differs from the message outside its cut bytes: read the whole message');
    i += n;
    j += n;
  };
  for (const g of m.gaps) {
    if (!Array.isArray(g) || !offset(g[0]) || !offset(g[1]) || g[0] < i || g[0] + g[1] > f.length) fail('bytes', '`ref.missing.gaps` are [offset, length] in order, within the range');
    same(g[0] - i);
    if (!cuttable(f, i, i + g[1])) fail('bytes', 'the cut bytes hold a line starting with `--` or end with a CR: read the whole message');
    i += g[1];
  }
  same(f.length - i);
  if (j !== ref.end) fail('bytes', '`ref.missing` does not match the ref: read the whole message');
  return f;
}

/**
 * An image's type by its magic number: PNG, JPEG, GIF, WebP or AVIF, or null (never SVG, whatever the declared
 * type). What decides whether an inline part may become a blob URL.
 */
export function imageType(bytes: Uint8Array): ImageType | null {
  if (!(bytes instanceof Uint8Array)) fail('imageType', 'the bytes are a Uint8Array');
  return magic(bytes);
}
