// An image's type from its first bytes (docs/proposals/sinter-mail-mime.md, section 2): what decides whether an
// inline part may become a blob URL of the page's origin. Only formats that cannot run script: never SVG, whatever
// the declared type says.
import type { ImageType } from './types.js';

const at = (b: Uint8Array, o: number, s: string) => {
  if (b.length < o + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
};

/** how far into an `ftyp` box compatible brands are looked for */
const AVIF_SCAN = 4096;

/**
 * PNG, JPEG, GIF (87a, 89a), WebP (`RIFF`, a size, `WEBP`) or AVIF (an `ftyp` box first, with `avif` or `avis`
 * as its major brand or among its compatible brands), by magic number; anything else is null.
 */
export function imageType(bytes: Uint8Array): ImageType | null {
  if (at(bytes, 0, '\x89PNG\r\n\x1a\n')) return 'png';
  if (at(bytes, 0, '\xff\xd8\xff')) return 'jpeg';
  if (at(bytes, 0, 'GIF87a') || at(bytes, 0, 'GIF89a')) return 'gif';
  if (at(bytes, 0, 'RIFF') && at(bytes, 8, 'WEBP')) return 'webp';
  if (at(bytes, 4, 'ftyp')) {
    const size = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
    if (size < 16) return null;
    // the compatible brands, read in the first 4 kB at most
    const end = Math.min(size, bytes.length, AVIF_SCAN);
    if (at(bytes, 8, 'avif') || at(bytes, 8, 'avis')) return 'avif';
    for (let o = 16; o + 4 <= end; o += 4) if (at(bytes, o, 'avif') || at(bytes, o, 'avis')) return 'avif';
  }
  return null;
}
