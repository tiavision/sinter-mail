// GFM autolink literals, as github.com (cmark-gfm) finds them, over a plain string: `www.` and `http(s)://` URLs,
// emails, and `mailto:` emails. Ported from sinter-markdown's scripts/autolink.js (the same organisation and
// licence), where it is a markdown-it rule; here it splits a text run for mail.plain.
//
// Only `http:`, `https:` and `mailto:` hrefs come out, so no link this makes can be `javascript:`. GFM's `ftp://`
// URLs and `xmpp:` addresses are still found, so that their parts are not linked on their own (the email in
// `xmpp:a@b.c`), and left as text. The href is the text as written (`www.` gets `http://`, an email `mailto:`), as
// md.parse keeps a destination.
//
// One difference from GFM: a URL also ends at `>`, so the `<https://…>` of plain-text mail (RFC 3986, appendix C)
// does not take its bracket. `>` is never a URL's own character unescaped.
//
// Linear in the text: every match moves the scan forward, a run of email characters without an `@` is passed over
// whole, and the end of a link is trimmed by an index, its parentheses counted once.

/** a piece of a text run: text as it is, or a link with its href and text */
export type Piece = string | { href: string; text: string };

/** a domain character: not whitespace, not ASCII punctuation other than `-` and `_` (non-ASCII is a domain's) */
const D = '[^\\s!-,./:-@[-^`{-~]';
/** at each position, in order: a scheme or `www.`, `mailto:` or `xmpp:` before an email, a run of email characters */
const SCAN = /(?:https?:\/\/|ftp:\/\/|www\.)|(?:mailto|xmpp):(?=[\w.+-]+@)|[\w.+-]+@?/gi;
const DOMAIN = new RegExp(`${D}+(?:\\.${D}+)*`, 'uy');
const PATH = /[^\s<>]*/y, EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/y, XMPP = /\/[\w@.-]*/y, ENTITY = /^&[a-z\d]+;$/i;
/** what ends a URL but is not its own */
const TRAILING = '?!.,:*_~\'"';

function exec(re: RegExp, s: string, i: number): string | null {
  re.lastIndex = i;
  return re.exec(s)?.[0] ?? null;
}

/** the end of the link at `i` in `s` and its href, or null; `start` is what SCAN matched at `i` */
function linkAt(s: string, i: number, start: string): [number, string] | null {
  if (start.endsWith('@') || start.endsWith(':')) {
    // an email, after `mailto:` or `xmpp:` or none: a `.` after it is not its own, and it ends in no `-` or `_`
    const scheme = start.endsWith(':') ? start : '', j = i + scheme.length;
    let email = exec(EMAIL, s, j);
    if (!email) return null;
    if (email.endsWith('.')) email = email.slice(0, -1);
    if (/[-_]$/.test(email)) return null;
    let end = j + email.length;
    if (/^xmpp/i.test(scheme)) { const r = exec(XMPP, s, end); if (r) end += r.replace(/\.$/, '').length; }
    return [end, (scheme || 'mailto:') + s.slice(j, end)];
  }
  // a URL: a valid domain (no `_` in its last two segments; `www.` and at least one more period), then up to a
  // space, `<` or `>`
  const www = /^www/i.test(start), host = i + (www ? 0 : start.length);
  const domain = exec(DOMAIN, s, host);
  if (!domain) return null;
  const segments = domain.split('.');
  if (/_/.test(segments.slice(-2).join('')) || (www && segments.length < 3)) return null;
  const from = host + domain.length;
  let end = from + exec(PATH, s, from)!.length, open = 0, close = 0;
  for (let k = i; k < end; k++) if (s[k] === '(') open++; else if (s[k] === ')') close++;
  // what ends it and is not its own: trailing punctuation, a `)` with no `(`, an entity-like `&name;`
  while (end > from) {
    const c = s[end - 1]!;
    if (TRAILING.includes(c)) end--;
    else if (c === ')' && close > open) { close--; end--; }
    else if (c === ';') {
      const amp = s.lastIndexOf('&', end - 1);
      if (amp >= from && ENTITY.test(s.slice(amp, end))) end = amp; else break;
    } else break;
  }
  return [end, www ? 'http://' + s.slice(i, end) : s.slice(i, end)];
}

/**
 * `s` split at its autolinks: text runs (never empty) and links, in order. Past `max` links, the rest of `s`
 * is text.
 */
export function autolink(s: string, max = Infinity): Piece[] {
  const out: Piece[] = [];
  if (max <= 0) return s ? [s] : [];
  // a fresh regex per call: its lastIndex is the scan's state
  const scan = new RegExp(SCAN.source, SCAN.flags);
  let pos = 0, m: RegExpExecArray | null;
  while ((m = scan.exec(s))) {
    const i = m.index, start = m[0], prev = i ? s[i - 1]! : ' ';
    const email = start.endsWith('@') || start.endsWith(':');
    if (!email && !/^(?:https?:|ftp:|www\.)/i.test(start)) continue;   // a run with no `@`: passed over
    // `www.` after whitespace or `*`, `_`, `~`, `(`; a scheme after no letter or digit; an email after none of
    // its own characters
    const ok = /^www/i.test(start) ? /[\s*_~(]/.test(prev) : email ? !/[\w.+-]/.test(prev) : !/[a-z\d]/i.test(prev);
    const r = ok ? linkAt(s, i, start) : null;
    if (!r) { if (!start.endsWith('@')) scan.lastIndex = i + 1; continue; }
    scan.lastIndex = r[0];
    // GFM's other schemes: found, and left in the text
    if (!/^(?:https?|mailto):/i.test(r[1])) continue;
    if (i > pos) out.push(s.slice(pos, i));
    out.push({ href: r[1], text: s.slice(i, r[0]) });
    pos = r[0];
    if (--max <= 0) break;
  }
  if (pos < s.length) out.push(s.slice(pos));
  return out;
}
