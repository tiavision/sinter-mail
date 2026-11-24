// Dates (RFC 5322, 3.3, with the obsolete forms of 4.3 and what clients send besides), read with plain arithmetic:
// `Date` is not a fold global, and the sender's offset is kept rather than converted
// (docs/proposals/sinter-mail-mime.md, sections 2 and 3, "Settled for implementation").
//
// One pass over tokens; comments are dropped with their nesting counted, not recursed into.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** RFC 5322's obsolete zones, in minutes east of UTC; military letters and unknown names are -0000 (4.3) */
const ZONES = new Map<string, number>([['ut', 0], ['utc', 0], ['gmt', 0], ['z', 0], ['edt', -240], ['est', -300], ['cdt', -300], ['cst', -360],
  ['mdt', -360], ['mst', -420], ['pdt', -420], ['pst', -480]]);

type Tok = { k: 'num' | 'word' | 'punct'; v: string };

function tokens(s: string): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < s.length;) {
    const c = s.charCodeAt(i);
    if (c === 0x28) {
      let depth = 0;
      for (; i < s.length; i++) {
        const d = s.charCodeAt(i);
        if (d === 0x5c) i++;
        else if (d === 0x28) depth++;
        else if (d === 0x29 && --depth === 0) break;
      }
      i++;
      continue;
    }
    const from = i;
    if (c >= 0x30 && c <= 0x39) {
      while (i < s.length && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x39) i++;
      out.push({ k: 'num', v: s.slice(from, i) });
    } else if ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a) {
      while (i < s.length && ((s.charCodeAt(i) | 0x20) >= 0x61 && (s.charCodeAt(i) | 0x20) <= 0x7a)) i++;
      out.push({ k: 'word', v: s.slice(from, i).toLowerCase() });
    } else {
      if (c > 0x20) out.push({ k: 'punct', v: s[i]! });
      i++;
    }
  }
  return out;
}

/** the index of the month or day a word names (its first three letters or more), or -1 */
const named = (list: readonly string[], w: string) => w.length >= 3 ? list.findIndex((n) => n.startsWith(w)) : -1;

const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * An RFC 5322 date (`Tue, 24 Nov 2026 09:30:00 +0100`) as ISO 8601 in the sender's offset
 * (`2026-11-24T09:30:00+01:00`), or null. Accepted besides: a missing or disagreeing day of the week (ignored),
 * comments and extra whitespace, `-` between day, month and year, full month names, two-digit years (below 50 is
 * 20xx) and three-digit ones (+1900), missing seconds, one-digit hours, a `+hh:mm` zone, and the obsolete zone
 * names (UT, GMT, EST to PDT); military letters but Z, unknown names, a missing zone and `-0000` itself are -0000, an
 * unknown offset (RFC 5322 3.3 and 4.3), written `-00:00` as RFC 3339 writes it.
 * Refused: a day the month does not have (leap years counted), a year before 1900, a time or offset out of range.
 */
export function parseDate(raw: string): string | null {
  const t = tokens(raw);
  let i = 0;
  const num = (min: number, max: number): number | null => {
    const x = t[i];
    if (!x || x.k !== 'num' || x.v.length < min || x.v.length > max) return null;
    i++;
    return Number(x.v);
  };
  const punct = (v: string) => { if (t[i]?.k === 'punct' && t[i]!.v === v) { i++; return true; } return false; };
  if (t[i]?.k === 'word') {
    if (named(DAYS, t[i]!.v) < 0) return null;
    i++;
    punct(',');
  }
  const day = num(1, 2);
  if (day === null) return null;
  punct('-');
  const m = t[i]?.k === 'word' ? named(MONTHS, t[i]!.v) : -1;
  if (m < 0) return null;
  i++;
  punct('-');
  const ys = t[i]?.k === 'num' ? t[i]!.v.length : 0;
  let year = num(2, 4);
  if (year === null) return null;
  if (ys === 2) year += year < 50 ? 2000 : 1900;
  else if (ys === 3) year += 1900;
  if (year < 1900) return null;
  const hour = num(1, 2);
  if (hour === null || !punct(':')) return null;
  const minute = num(1, 2);
  if (minute === null) return null;
  let second = 0;
  if (punct(':')) { const s = num(1, 2); if (s === null) return null; second = s; }
  let offset = 0, unknown = true;
  const z = t[i];
  if (z && z.k === 'punct' && (z.v === '+' || z.v === '-')) {
    i++;
    const d = t[i];
    if (!d || d.k !== 'num') return null;
    i++;
    let hh: number, mm = 0;
    if (d.v.length === 4) { hh = Number(d.v.slice(0, 2)); mm = Number(d.v.slice(2)); }
    else if (d.v.length <= 2) { hh = Number(d.v); if (punct(':')) { const x = num(2, 2); if (x === null) return null; mm = x; } }
    else return null;
    if (hh > 23 || mm > 59) return null;
    offset = (z.v === '-' ? -1 : 1) * (hh * 60 + mm);
    unknown = offset === 0 && z.v === '-';
  } else if (z && z.k === 'word' && ZONES.has(z.v)) { offset = ZONES.get(z.v)!; unknown = false; }
  const length = m === 1 && leap(year) ? 29 : LENGTHS[m]!;
  if (day < 1 || day > length || hour > 23 || minute > 59 || second > 60) return null;
  const a = Math.abs(offset);
  return `${pad(year, 4)}-${pad(m + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${offset < 0 || unknown ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
