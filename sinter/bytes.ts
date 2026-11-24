// `mail.bytes(bytes, ref, options)` and `mail.imageType(bytes)` (docs/proposals/sinter-mail-mime.md, sections 1
// and 2): the bytes a message's Ref names, and an image's type by its magic number. This module imports only the
// transfer decoders and the magic numbers, relatively, never the reader: both stay ordinary helpers when an app
// makes the package lazy. Pure, with no globals beyond the language's and TextEncoder.
import { canonicalize, transferDecode } from './mime/decode.js';
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
 * the decoded bytes, then with `canonical` every bare LF made CRLF. A new array each call. A TypeError for a Ref
 * outside its source, or whose source step has no `ok` plaintext.
 */
export function bytes(input: Uint8Array | string, ref: Ref, options?: BytesOptions): Uint8Array {
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
  let out = transferDecode(src, start, end, encoding);
  if (slice !== undefined) {
    if (!Array.isArray(slice) || slice.length !== 2 || !offset(slice[0]) || !offset(slice[1]) || slice[0] > slice[1] || slice[1] > out.length) {
      fail('bytes', `\`ref.slice\` is [start, end] within the ${out.length} decoded bytes, not ${JSON.stringify(slice)}`);
    }
    out = out.slice(slice[0], slice[1]);
  }
  return canonical ? canonicalize(out) : out;
}

/**
 * An image's type by its magic number: PNG, JPEG, GIF, WebP or AVIF, or null (never SVG, whatever the declared
 * type). What decides whether an inline part may become a blob URL.
 */
export function imageType(bytes: Uint8Array): ImageType | null {
  if (!(bytes instanceof Uint8Array)) fail('imageType', 'the bytes are a Uint8Array');
  return magic(bytes);
}
