// An attachment's name, made safe to save (docs/proposals/sinter-mail-mime.md, section 4, "Filenames"): which
// parameter names it, what is removed, Windows' reserved names, the length. The name as decoded stays beside it,
// controls removed, for display only.
import { ignore, type Sink } from './decode.js';
import { clean, param } from './headers.js';

type Params = readonly (readonly [string, string])[];

/** path separators, `:`, C0 and C1 controls, DEL, and the bidirectional controls (`evil\u202efdp.exe`) */
const REMOVED = /[/\\:\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;

/** characters Windows refuses in a name: made `_` */
const REPLACED = /[<>|?*"]/g;

/** CON, PRN, AUX, NUL, CONIN$, CONOUT$, COM0 to COM9, LPT0 to LPT9 (and their superscript digits), as the part
 * before any dot */
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

export const MAX_FILENAME = 255;

/** the names in order of precedence: Content-Disposition's, then Content-Type's */
const DISPOSITION = ['filename*', 'filename'], TYPE = ['name*', 'name'];

/**
 * A name safe to save and the name as decoded, from the parameters of Content-Disposition and Content-Type (as
 * headers.parameterField returns them): `filename*`, then `filename`, then `name*`, then `name`. When the ones
 * present do not all agree, `conflicts` names them and the sink gets `parameter-conflict` (the caller decides
 * whether that blocks). Removed: path separators, `:`, controls, bidirectional controls, leading dots and
 * whitespace, trailing dots and whitespace (again after a cut); `<>|?*"` become `_`. A Windows reserved name
 * (`CON`, `CONIN$`, `nul.txt`, `COM1.tar.gz`) gets a `_`
 * prefix. Past 255 UTF-16 code units the stem is cut, keeping the extension (up to 32 units) and never splitting a
 * surrogate pair. Empty is `attachment`.
 */
export function filename(disposition: Params, type: Params, sink: Sink = ignore): { filename: string; originalFilename: string | null; conflicts: string[] } {
  const present: [string, string][] = [];
  for (const n of DISPOSITION) { const v = param(disposition, n); if (v !== null) present.push([n, v]); }
  for (const n of TYPE) { const v = param(type, n); if (v !== null) present.push([n, v]); }
  const originalFilename = present.length ? clean(present[0]![1]) : null;
  const agree = present.every(([, v]) => v === present[0]![1]);
  if (!agree) sink('parameter-conflict');
  return { filename: safeName(originalFilename ?? ''), originalFilename, conflicts: agree ? [] : present.map(([n]) => n) };
}

const trimmed = (c: string) => c === '.' || /\s/.test(c);

/** `s` without trailing dots and whitespace */
function trimEnd(s: string): string {
  let b = s.length;
  while (b > 0 && trimmed(s[b - 1]!)) b--;
  return s.slice(0, b);
}

/** `s` cut to `max` UTF-16 code units, keeping the extension (up to 32 units), never splitting a surrogate pair */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const d = s.lastIndexOf('.');
  const ext = d > 0 && s.length - d <= 32 ? s.slice(d) : '';
  let keep = max - ext.length;
  const hi = s.charCodeAt(keep - 1);
  if (hi >= 0xd800 && hi <= 0xdbff) keep--;
  return s.slice(0, keep) + ext;
}

const reserved = (s: string) => { const dot = s.indexOf('.'); return RESERVED.test((dot < 0 ? s : s.slice(0, dot)).trimEnd()); };

/** `name` made safe by the rules of `filename`; trailing dots and whitespace are trimmed again after a cut */
export function safeName(name: string): string {
  let s = name.replace(REMOVED, '').replace(REPLACED, '_');
  let a = 0;
  while (a < s.length && trimmed(s[a]!)) a++;
  s = trimEnd(s.slice(a));
  s = trimEnd(cut(s, MAX_FILENAME));
  if (reserved(s)) s = '_' + trimEnd(cut(s, MAX_FILENAME - 1));
  return s || 'attachment';
}
