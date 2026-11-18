import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { autolink } from '../sinter/autolink.js';
import { plain } from '../sinter/plain.js';
import type { Element, Node } from '../sinter/sinter.types.js';

const t = (value: string): Node => ({ type: 'text', value });
const p = (...children: Node[]): Element => ({ type: 'element', tag: 'p', attrs: {}, style: { 'white-space': 'pre-wrap' }, children });
const a = (href: string, value: string): Element => ({ type: 'element', tag: 'a', attrs: { href }, style: {}, children: [t(value)] });
const quote = (...children: Node[]): Element => ({ type: 'element', tag: 'blockquote', attrs: {}, style: {}, part: 'quote', children });
const sig = (...children: Node[]): Element => ({ type: 'element', tag: 'div', attrs: {}, style: {}, part: 'signature', children });
const body = (...children: Node[]) => ({ type: 'body', style: {}, children, images: { origins: [] } });
const kids = (s: string, o?: Parameters<typeof plain>[1]) => plain(s, o).children;

describe('mail.plain', () => {
  test('paragraphs: runs of lines between blank lines, line breaks and spacing as written', () => {
    expect(plain('Hi Ann,\r\n\r\nThe  report\ris attached.\n\tThanks\n\n\n')).toEqual(body(p(t('Hi Ann,')), p(t('The  report\nis attached.\n\tThanks'))));
    // a line of only whitespace is blank; trailing spaces stay
    expect(kids('a  \n \t \nb')).toEqual([p(t('a  ')), p(t('b'))]);
    expect(plain('')).toEqual(body());
    expect(plain(null)).toEqual(body());
    expect(plain(undefined)).toEqual(body());
    expect(plain(42 as unknown as string)).toEqual(body());
    expect(plain('\n\n  \n')).toEqual(body());
  });

  test('quotes: one blockquote per level, `>` with an optional space, a level change closes or opens them', () => {
    expect(kids('On Monday, Ann wrote:\n> Are we on?\n> Yes?\n\nSure.')).toEqual([
      p(t('On Monday, Ann wrote:')), quote(p(t('Are we on?\nYes?'))), p(t('Sure.')),
    ]);
    // `>>` and `> >` are both two levels; one space after a mark is the mark's, more are the text's
    expect(kids('> a\n>> b\n> > c\n>  d')).toEqual([quote(p(t('a')), quote(p(t('b\nc'))), p(t(' d')))]);
    // a `>` line is a blank line inside the quote; an unquoted blank line ends it
    expect(kids('> a\n>\n> b\n\n> c')).toEqual([quote(p(t('a')), p(t('b'))), quote(p(t('c')))]);
    // a deeper blank line opens nothing; a jump of levels opens each
    expect(kids('> a\n>>>\n> b\n>>> c')).toEqual([quote(p(t('a')), p(t('b')), quote(quote(p(t('c')))))]);
    expect(kids('>> a\nb')).toEqual([quote(quote(p(t('a')))), p(t('b'))]);
    // only at a line's start
    expect(kids('a > b')).toEqual([p(t('a > b'))]);
  });

  test('quote nesting is bounded: levels past 32 are level 32', () => {
    const deep = (n: number): Node[] => (n ? [quote(...deep(n - 1))] : [p(t('x'))]);
    expect(kids('>'.repeat(40) + ' x')).toEqual(deep(32));
    expect(kids('> '.repeat(40) + 'x')).toEqual(deep(32));
    expect(kids('>'.repeat(40) + ' x', { flowed: true })).toEqual(deep(32));
  });

  test('signature: from a line that is exactly `-- `, the separator shown as its first line', () => {
    expect(kids('Thanks\n-- \nAnn\nwww.ann.example')).toEqual([
      p(t('Thanks')), sig(p(t('-- \nAnn\n'), a('http://www.ann.example', 'www.ann.example'))),
    ]);
    expect(kids('a\n\n-- \n\nAnn\n\n-- \nmore')).toEqual([p(t('a')), sig(p(t('-- ')), p(t('Ann')), p(t('-- \nmore')))]);
    // `--` alone, `-- x`, `---` and a quoted `-- ` are not separators
    expect(kids('--\n-- x\n---\n> -- ')).toEqual([p(t('--\n-- x\n---')), quote(p(t('-- ')))]);
    // quotes open in the signature are closed before it; quotes after it are inside it
    expect(kids('> q\n-- \nAnn\n> old')).toEqual([quote(p(t('q'))), sig(p(t('-- \nAnn')), quote(p(t('old'))))]);
  });

  test('links: URLs, www. addresses and emails, in paragraphs and quotes', () => {
    expect(kids('See https://example.com/a?b=1, or mail ann@example.com.\n> (www.example.org/x)')).toEqual([
      p(t('See '), a('https://example.com/a?b=1', 'https://example.com/a?b=1'), t(', or mail '), a('mailto:ann@example.com', 'ann@example.com'), t('.')),
      quote(p(t('('), a('http://www.example.org/x', 'www.example.org/x'), t(')'))),
    ]);
    // a link ends at a line's end, and a bracketed one at its `>`
    expect(kids('<https://example.com/path>\nhttps://a.example\nnext')).toEqual([
      p(t('<'), a('https://example.com/path', 'https://example.com/path'), t('>\n'), a('https://a.example', 'https://a.example'), t('\nnext')),
    ]);
    // only http, https and mailto: other schemes stay text
    expect(kids('javascript:alert(1)//x.com ftp://f.example/x xmpp:a@b.example data:text/html,x')).toEqual([p(t('javascript:alert(1)//x.com ftp://f.example/x xmpp:a@b.example data:text/html,x'))]);
  });

  test('flowed (RFC 3676): soft breaks joined at the same depth, space-stuffing removed', () => {
    const o = { flowed: true };
    expect(kids('This is a \nflowed paragraph.\nA fixed line.\n\nNext', o)).toEqual([p(t('This is a flowed paragraph.\nA fixed line.')), p(t('Next'))]);
    // the stuffed space goes: ` From`, `  x`
    expect(kids(' From here\n  indented', o)).toEqual([p(t('From here\n indented'))]);
    // depth is the count of `>` with no space between; then a stuffed space goes
    expect(kids('>> a \n>> b\n> > c', o)).toEqual([quote(quote(p(t('a b'))), p(t('> c')))]);
    // no join across a depth change, a blank line, or into the signature separator, which is not flowed
    expect(kids('> a \nb \n\nc \n-- \nAnn', o)).toEqual([quote(p(t('a '))), p(t('b ')), p(t('c ')), sig(p(t('-- \nAnn')))]);
    // without flowed, a trailing space is a hard break as written and `> >` two levels
    expect(kids('a \nb\n> > c')).toEqual([p(t('a \nb')), quote(quote(p(t('c'))))]);
  });

  test('delsp: the space before a soft break goes too', () => {
    expect(kids('Supercali \nfragilistic \nexpialidocious', { flowed: true, delsp: true })).toEqual([p(t('Supercalifragilisticexpialidocious'))]);
    // a long URL wrapped with DelSp is one link again
    expect(kids('https://example.com/a \nb', { flowed: true, delsp: true })).toEqual([p(a('https://example.com/ab', 'https://example.com/ab'))]);
    // delsp means nothing without flowed
    expect(plain('a \nb', { delsp: true })).toBe(plain('a \nb'));
  });

  test('options are checked', () => {
    expect(() => plain('x', { flowed: 'yes' as unknown as boolean })).toThrow(TypeError);
    expect(() => plain('x', { flowed: true, delsp: 1 as unknown as boolean })).toThrow(TypeError);
    expect(plain('x', null as unknown as undefined)).toBe(plain('x'));
  });

  test('memo: the same text and options give the same frozen tree', () => {
    const s = 'Hello\n> www.example.com\n-- \nAnn';
    const b = plain(s);
    expect(plain(s)).toBe(b);
    expect(plain(s, {})).toBe(b);
    expect(plain(s, { flowed: false, delsp: true })).toBe(b);
    expect(plain(s, { flowed: true })).not.toBe(b);
    expect(plain(s, { flowed: true })).toBe(plain(s, { flowed: true, delsp: false }));
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.isFrozen(b.children)).toBe(true);
    const q = b.children[1] as Element;
    expect(Object.isFrozen(q.children[0])).toBe(true);
    expect(Object.isFrozen((q.children[0] as Element).style)).toBe(true);
    expect(Object.isFrozen(b.images.origins)).toBe(true);
  });

  test('linear: hostile inputs in well under a second', () => {
    const mb = 1 << 20;
    const hostile = [
      '>'.repeat(mb), '> '.repeat(mb / 2), '>\n'.repeat(mb / 2),
      // 33 elements for each 38 characters: linear, but the tree itself is large, so a tenth of the size
      ('>'.repeat(32) + ' a\nb\n').repeat(mb / 400),
      'www.' + 'a.'.repeat(mb / 2), 'www.a.a' + '.a'.repeat(mb / 2), '('.repeat(mb), 'http://' + '('.repeat(mb / 2) + ')'.repeat(mb / 2),
      'a.'.repeat(mb / 2), 'a@'.repeat(mb / 2), 'www.a.b '.repeat(mb / 8), 'x@a.b '.repeat(mb / 6), 'www.a.b/' + '?'.repeat(mb),
      'a \n'.repeat(mb / 3), '-- \n'.repeat(mb / 4), '\n'.repeat(mb),
    ];
    for (const s of hostile) for (const o of [{}, { flowed: true, delsp: true }]) {
      const start = performance.now();
      plain(s, o);
      expect(performance.now() - start, JSON.stringify(s.slice(0, 12))).toBeLessThan(1000);
    }
  });

  test('past 2,000 links in a body, the rest stays text', () => {
    const s = 'x@a.b '.repeat(2_500);
    const links: Element[] = [];
    let text = '';
    const walk = (n: Node) => {
      if (n.type === 'text') text += n.value;
      else { if (n.tag === 'a') links.push(n); n.children.forEach(walk); }
    };
    plain(s).children.forEach(walk);
    expect(links.length).toBe(2_000);
    expect(text === s).toBe(true);
    expect(autolink('www.a.b www.c.d www.e.f', 2).map((p) => (typeof p === 'string' ? p : p.text))).toEqual(['www.a.b', ' ', 'www.c.d', ' www.e.f']);
  });

  test('plain.ts imports no parser', () => {
    for (const f of ['plain.ts', 'autolink.ts']) {
      const src = readFileSync(new URL(`../sinter/${f}`, import.meta.url), 'utf8');
      const imports = [...src.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      expect(imports.filter((i) => /parser|parse\.js|\/parse$/.test(i!)), f).toEqual([]);
    }
  });
});

// sinter-markdown's test/parse.test.ts, "GFM autolinks": the spec's examples, through the plain-string port
describe('autolink', () => {
  const links = (s: string) => autolink(s).filter((x) => typeof x !== 'string').map((x) => [x.href, x.text]);

  test('GFM autolinks: www., http(s):// and emails, as github.com links them', () => {
    expect(links('www.commonmark.org/help, and (www.google.com/search?q=Markup+(business))')).toEqual([
      ['http://www.commonmark.org/help', 'www.commonmark.org/help'],
      ['http://www.google.com/search?q=Markup+(business)', 'www.google.com/search?q=Markup+(business)'],
    ]);
    expect(links('www.google.com/search?q=(business))+ok')).toEqual([['http://www.google.com/search?q=(business))+ok', 'www.google.com/search?q=(business))+ok']]);
    expect(links('www.google.com/search?q=commonmark&hl;')).toEqual([['http://www.google.com/search?q=commonmark', 'www.google.com/search?q=commonmark']]);
    expect(links('www.commonmark.org/he<lp')).toEqual([['http://www.commonmark.org/he', 'www.commonmark.org/he']]);
    // ftp:// is found, as GFM finds it, and left as text
    expect(links('(Visit https://encrypted.google.com/search?q=Markup+(business)) or ftp://foo.bar.baz.')).toEqual([
      ['https://encrypted.google.com/search?q=Markup+(business)', 'https://encrypted.google.com/search?q=Markup+(business)'],
    ]);
    expect(links('"http://google.com" ~~http://x.org~~ **http://inlines**')).toEqual([['http://google.com', 'http://google.com'], ['http://x.org', 'http://x.org'], ['http://inlines', 'http://inlines']]);
    // xmpp: is found and left as text, its email not linked on its own
    expect(links('foo@bar.baz, hello+xyz@mail.example. a.b-c_d@a.b- mailto:x@y.zz xmpp:x@y.zz/home.')).toEqual([
      ['mailto:foo@bar.baz', 'foo@bar.baz'], ['mailto:hello+xyz@mail.example', 'hello+xyz@mail.example'],
      ['mailto:x@y.zz', 'mailto:x@y.zz'],
    ]);
    // the last two segments of a domain have no underscore; www. needs a domain; a bare domain is text
    expect(links('www.xxx._yyy.zzz www._xxx.yyy.zzz www. www.x example.com config.md ASP.NET')).toEqual([['http://www._xxx.yyy.zzz', 'www._xxx.yyy.zzz']]);
    // a scheme after a letter, www. after a letter, an email inside a word: not links
    expect(links('xhttp://a.example awww.a.example')).toEqual([]);
    // only these schemes come out
    expect(links('javascript:alert(1)//x.com data:text/html,www.a.com ftp://www.a.com ftp://u@a.example')).toEqual([]);
  });

  test('text runs and links in order, nothing lost', () => {
    const s = 'a https://x.example/(b) c (www.y.example). d@e.example';
    const pieces = autolink(s);
    expect(pieces).toEqual(['a ', { href: 'https://x.example/(b)', text: 'https://x.example/(b)' }, ' c (', { href: 'http://www.y.example', text: 'www.y.example' }, '). ', { href: 'mailto:d@e.example', text: 'd@e.example' }]);
    expect(pieces.map((x) => (typeof x === 'string' ? x : x.text)).join('')).toBe(s);
    expect(autolink('')).toEqual([]);
    expect(autolink('no links')).toEqual(['no links']);
  });

  test('autolinks stay linear', () => {
    const hostile = [
      'a.'.repeat(1e5), 'a.'.repeat(1e5) + '@', 'a@'.repeat(5e4), '_'.repeat(1e5) + '@a.b', 'www.' + 'a.'.repeat(1e5),
      'x '.repeat(5e4) + 'www.a.b' + ')'.repeat(5e4), 'http://' + '('.repeat(1e5) + ')'.repeat(1e5),
      'www.a.b/' + '&a;'.repeat(3e4), 'www.a.b/' + '?'.repeat(1e5), 'www.a.b '.repeat(3e4), 'x@a.b '.repeat(3e4),
      'ftp://a.b '.repeat(3e4), 'xmpp:a@b.c '.repeat(3e4), 'mailto:'.repeat(5e4) + 'a@b.c',
    ];
    for (const s of hostile) {
      const start = performance.now();
      autolink(s);
      expect(performance.now() - start, JSON.stringify(s.slice(0, 12))).toBeLessThan(1000);
    }
  });
});
