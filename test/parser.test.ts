// sinter/parser against the reference parse (parse5, the HTML standard's tree construction): the same raw
// tree for targeted documents in every area of tokenization and tree construction, and for a few thousand
// random ones; the depth bound; linear time on hostile input; the generated entity table; purity.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parseHTML } from '../sinter/parser/index.js';
import type { RawElement, RawNode } from '../sinter/raw.js';
import { plainOf, reference } from './reference.js';

const same = (html: string): void => {
  expect(plainOf(parseHTML(html)), JSON.stringify(html)).toEqual(plainOf(reference(html)));
};
const cases = (name: string, list: string[]): void => {
  test(name, () => { for (const html of list) same(html); });
};

test('the raw tree', () => {
  const tree = parseHTML('<p class=x>a<!--c-->b<table><tr><td>c</table><svg><g/></svg><template>t</template>');
  expect(plainOf(tree)).toEqual(['html', {}, ['head', {}], ['body', {}, ['p', { class: 'x' }, 'ab', ['table', {}, ['tbody', {}, ['tr', {}, ['td', {}, 'c']]]], ['template', {}]]]]);
  const p = (tree.children[1] as RawElement).children[0] as RawElement;
  expect(p.parent).toBe(tree.children[1]);
  expect(tree.parent).toBe(null);
});

describe('the tokenizer', () => {
  cases('text, newlines and NUL', [
    '', 'hello', 'a\r\nb\rc\nd', 'a\0b', '\0', '<p>\0x\0</p>', 'a < b', 'a <3 b', '<', 'a<', '</', 'a</', '</>x', '</ x>y', '<?php x ?>y',
    '﻿a', 'x y', '<b>\ud800</b>',
  ]);
  cases('tags and attributes', [
    '<DIV CLASS=X>a</DIV>', '<div class="a" class="b" id=c>', "<a href='x' title=\"y\" z=w>", '<a href=x/>t', '<br/>x', '<div/>x',
    '<a b c=d e>', '<a =x>', '<a b=>', '<a b= c>', '<a b="x"c>', '<a b=x"y\'z<`=>', '<a/b/c>', '<a \0=\0>', '<d\0iv>',
    '<a b="x', '<a b', '<a', '<div a="1" A="2">', '<x-y z.w:v="1">', '<a b="&amp;">', '<p\n\tid\n=\n"x"\n>',
    '<b></b x="y">', '</b/>', '<a b="x\r\ny">',
  ]);
  cases('character references', [
    '&amp; &lt; &gt; &quot; &apos; &nbsp;', '&amp &lt &copy &COPY', '&ampx &notit; &notin; &notin &not', '&#65; &#x41; &#X41 &#065',
    '&#0; &#x110000; &#xD800; &#xDFFF; &#99999999999; &#x0000000041;', '&#128; &#x80; &#x9F; &#x81; &#x8D; &#150;', '&#13; &#10; &#9;',
    '&#; &#x; &#xg; &# &', '&unknown; &AMP &AMP;', '&amp;amp;', '&NotNestedLessLess; &CounterClockwiseContourIntegral;',
    '&nvlt; &bne; &fjlig;', '&zwnj;&zwj;', '&ampamp', '&a', '&;', '&#x1F600;', '&#xFFFE; &#x1FFFF;', '&#x7F;',
    '<a href="?a=1&amp=2&copy=3&copy;=4&copyx&copy">', '<a title="&notin &not &notx &not= &amp1">', '<a b=&amp=x c=&amp;=y d=&ampx>',
    '<a b="&#65=">', '<textarea>&amp;&lt;b&gt;</textarea>', '<title>&amp</title>', '<style>&amp;</style>',
  ]);
  cases('raw text, RCDATA, script data and PLAINTEXT', [
    '<style>a<b>c</style>d', '<style>x</STYLE >y', '<style>x</style', '<style>x</stylex>y</style>', '<title>a<b>c</title>', '<textarea>\nx</textarea>',
    '<textarea>\n\nx</textarea>', '<textarea></textarea>', '<xmp><b></xmp>', '<iframe><p></iframe>', '<noembed><p></noembed>',
    '<noframes><p></noframes>', '<noscript><p>x</p></noscript>', '<head><noscript><link></noscript></head>', '<plaintext><b>x</plaintext>y',
    '<script>a</script>', '<script>a<!--b</script>c', '<script><!--<script>x</script>y</script>z', '<script><!--<script>x--></script>y',
    '<script><!--x--></script>y', '<script><!-->x</script>', '<script><!--<script x>a</script >b</script>c', '<script>a</scriptx>b</script>',
    '<script><!--<SCRIPT>a</SCRIPT>b-->c</script>d', '<script>x', '<style>\0</style>', '<title>\0</title>', '<plaintext>\0',
    '<script><!--<script></script>-></script>x', '<script><!---</script>', '<script><!--a--!></script>',
  ]);
  cases('comments, bogus comments, doctypes and CDATA', [
    'a<!--x-->b', 'a<!-->b', 'a<!--->b', 'a<!---->b', 'a<!-- -- -->b', 'a<!--x--!>b', 'a<!--x--!-->b', 'a<!--<!-->b', 'a<!--x', 'a<!-x>b',
    'a<!>b', 'a<!doctype html>b', '<!DOCTYPE html><p>x', 'a<![CDATA[x]]>b', '<svg><![CDATA[<b>]]></svg>x', '<math><![CDATA[x]]>y</math>z',
    '<svg><foreignObject><![CDATA[x]]></foreignObject></svg>', '<pre><!--x-->\nfoo</pre>', '<table> <!--x-->b</table>',
    '<table> <!DOCTYPE x>b</table>', '<!doctype>', '<!DOCTYPE', '<!doctype html',
  ]);
});

describe('quirks mode', () => {
  const doctypes = [
    '', '<!DOCTYPE html>', '<!doctype HTML>', '<!DOCTYPE htm>', '<!DOCTYPE>', '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">',
    '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">',
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">', '<!DOCTYPE html PUBLIC "HTML">', '<!DOCTYPE html SYSTEM "http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd">',
    '<!DOCTYPE html SYSTEM "about:legacy-compat">', "<!DOCTYPE html PUBLIC '-//W3C//DTD HTML 4.0 Frameset//EN'>", '<!DOCTYPE html PUBLIC "x" junk>',
    '<!DOCTYPE html PUBLIC "x" "y" junk>', '<!DOCTYPE html PUBLIC>', '<!DOCTYPE html SYSTEM>', '<!DOCTYPE html foo>', '<!DOCTYPE html PUBLIC "x>',
    '<!DOCTYPEhtml>', '<!DOCTYPE html PUBLIC"-//W3C//DTD HTML 4.01 Frameset//EN">',
  ];
  test('a p around a table', () => { for (const d of doctypes) same(d + '<p>a<table><tr><td>b</table>c'); });
});

describe('tree construction', () => {
  cases('implied html, head and body', [
    'x', ' x', '<html>', '<head>', '<body>', '</html>', '</head>x', '</body>x', '</br>', '</p>', '<html><head></head><body></body></html>',
    '<html a=1><html b=2 a=3>', '<body a=1><body b=2 a=3>', '<html><body><html c=1>', '<head><title>t</title><meta charset=utf-8><style>p{}</style></head>x',
    '<title>t</title>x', ' <head> </head> <body> x', '<head></head> <p>', '</head> x', '<html> <!--c--> <head>', '<base><link><meta><x>',
    '<style>a</style><p>', '<head><p>x', '<head></body>x', '<head><head>', '<head></head><head>', '</head></head>x', '<head></head><style>x</style>',
    '<head></head><title>x</title><p>', '<body></body>x', '<body></body></html>x', '<body></html> x', '</body></html><p>x', '</html><!--x--><p>',
    '<html></html> x <p>', 'x</body> y', '<head></head><template>a</template>',
  ]);
  cases('paragraphs, lists and headings', [
    '<p>a<p>b', '<p>a<div>b</div>c', '<p><h1>x</h1>', '<h1><h2>x</h2></h1>', '<h1>a</h2>b', '<h3>a<p>b</h3>c', '<ul><li>a<li>b</ul>',
    '<li>a<li>b', '<ol><li>a<ul><li>b</ol>c', '<dl><dt>a<dd>b<dt>c</dl>', '<li><div><li>x', '<li><span><li>x', '<li><p><li>x', '<dd><address><dt>x',
    '<p>a</p></p>b', '</p></p>', '<button><p>a<button>b', '<p><button>a</p>b', '<pre>\nx</pre>', '<pre>\n\nx</pre>', '<pre>x\n</pre>',
    '<listing>\nx</listing>', '<pre>&#10;x</pre>', '<pre> \nx</pre>', '<pre>\0\nx</pre>', '<p><hr>x', '<p><plaintext>x', '<ruby>a<rb>b<rt>c<rp>d<rtc>e<rt>f</ruby>',
    '<rt>x', '<ruby><rtc><rt>x</ruby>', '<menu><li>x</menu>', '<dir><li>x', '<li>a</li></li>b', '<dd>a</dd></dt>b', '<address><p>x</address>y',
    '<section><p>a</section>b', '<p><dialog>x', '<p><search>x</search>', '<p><main>x', '<center><p>x</center>', '<summary><p>x</summary>',
    '<div><p>x</div>y', '<p><span>x</p>y', '<form><p>x</form>y',
  ]);
  cases('formatting and the adoption agency', [
    '<b>a<i>b</b>c</i>d', '<b><p>a</b>b</p>', '<a href=1>a<a href=2>b</a>c', '<a><p><a>x', '<a>a<div>b</a>c</div>', '<b><div><i>x</b>y</i>z',
    '<p><b><i><u>x</p>y', '<b>x</p>y', '<b><b><b><b>x', '<b id=1><b id=1><b id=1><b id=1><p>x', '<b><i><b><i><b><i><b><i><p>x',
    '<font color=red>a<p>b</font>c', '<nobr>a<nobr>b', '<nobr><p>x<nobr>y', '<b>1<i>2<u>3<s>4<em>5<p>6</b>7', '<a><b><c><d><e><f><g><p>x</a>y',
    '<div><b>a</div>b', '<b><table><td>x</b>y</table>z', '<table><b><tr><td>x</b>y', '<b><td>x', '<a><table><a>x', '<a><svg><a>x</a></svg>y</a>',
    '<i><div><b>x</i>y</b>z', '<s><div><s>x</div>y', '<code><code><code><code><div>x</code>y', '<b>a<b>b</b>c</b>d', '<em><p><em>a</p>b</em>',
    '<b><button>x</b>y</button>', '<b><marquee>x</b>y', '<b><object><i>x</b></object>y', '<applet><b>x</applet>y', '<b><template><i>x</b></template>y',
    '<tt><big><small><strike><strong>x<p>y</tt>z', '<b><p><i>a<p>b</b>c', '<b class=x><b class=x><b class=x><b class=x>t<p>u',
    '<a><p>b<a>c</p>d', '<b><caption>x', '<b>x<frameset>', '<b><h1>x</b>y</h1>', '<b><svg><foreignObject><p>x</b>y',
  ]);
  cases('tables', [
    '<table><tr><td>a<td>b<tr><td>c</table>', '<table><td>x</table>', '<table><tr>x', '<table>x<tr><td>y</table>', '<table><caption>c<td>x</table>',
    '<table><colgroup><col><col></colgroup><tr>', '<table><col><td>x', '<table><thead><tr><th>h<tbody><tr><td>d<tfoot><tr><td>f</table>',
    '<table><tr><td><table><tr><td>x</table>y</table>', '<table><p>x</table>', '<table><div>x</div><td>y</table>', '<table> <tr> <td> x </td> </tr> </table>',
    '<table>  </table>', '<table>a b</table>', '<table>\0x</table>', '<table><tr>a</tr></table>', '<table><input type=hidden><input type=text></table>',
    '<table><form><tr><td><form>x</table>', '<table><style>s</style><script>x</script><td>', '<table><td><table></table>x', '<table><table>x',
    '<table></tbody></tr></td></table>x', '<table><tr></td></th></tr>', '<table><td></body></caption></col></colgroup></html>x', '<table><caption><p>x</table>y',
    '<table><caption>x</caption>y', '<table><caption><table></caption>', '<table><colgroup>x</colgroup>', '<table><colgroup> <col> x', '<table><colgroup></col></colgroup>x',
    '<table><tbody><td>x</tbody>y', '<table><tbody></table>x', '<table><tr><td>a</tr>b', '<table><tr><td>a</tbody>b', '<table><tr><td>a<caption>b',
    '<table><td><td></table>', '<td>x', '<tr><td>x', '<th>x</th>', '<caption>x', '<col>x', '<tbody>x', '<table><tr><th>a<td>b</th>c', '<table><thead><td>',
    '<p><table></table>', '<!DOCTYPE html><p><table></table>', '<table><a>x<tr>y</a>z', '<table><b>x</b></table>', '<table><select><option>x</table>y',
    '<table><td><select><option>x<td>y</table>', '<table><tr><td><select></td>x', '<table><td><select><table>', '<table><template><td>x</template></table>',
    '<table><tr><td><template><td></td></tr>x</template>', '<table><frameset>', '<table><input>', '<table><td>x</table></td>y', '<div><table><tr><td>x</div>y</table>',
    '<table><tbody><tr></tbody></tr>x', '<table><tr><td>x<tbody>', '<table><td><caption>', '<table><colgroup><template>x</template></colgroup>',
    '<table>x<!--c-->y</table>', '<table><tr>x<!--c--> </tr></table>', '<table><td>x</td> y</table>', '<table><thead>x<tr>', '<table><td><svg>x</td>y',
    '<table><svg><td>', '<table><math>x</math></table>', 'a<table>b<tr>c<td>d</table>', '<table><td><p>x</table>', '<table><td><b>x</table>y',
  ]);
  cases('select', [
    '<select><option>a<option>b</select>', '<select><optgroup><option>a<optgroup><option>b</select>', '<select><b>x</b></select>', '<select><select>x',
    '<select><input>x', '<select><textarea>x</textarea>', '<select><keygen>x', '<select>\0x</select>', '<select><option>a</optgroup>b', '<select><optgroup>a</option>b</optgroup>',
    '<select><hr><option>x', '<select><script>x</script></select>', '<select><template><option>x</template></select>', '<select></select>x', '</select>x',
    '<select><option><optgroup>x', '<option>a<option>b', '<optgroup>a<option>b', '<p><select><p>x', '<select><svg>x', '<select></table>x', '<select><option>a</select><option>b',
    '<select><caption>x', '<select><div>x</div></select>',
  ]);
  cases('template', [
    '<template>a<b>c</b></template>d', '<template><td>x</td></template>', '<template><tr><td>x</template>', '<template><col></template>x', '<template><caption>x</template>',
    '<template><template>x</template>y</template>z', '<template>', '<template><p>x', '<body><template><html a=1>', '<template><body a=1></template>',
    '<template><frameset>', '<template></div>x</template>', '<template><form><form></template>', '<head><template><p>x</template></head>', '<template><script>x</script></template>',
    '<template><table><td>x</template>', '<template><select><option>x</template>y', '<template><style>x</style></template>', '<div><template><div>a</template>b</div>',
    '<template><a><b></template>x', '<template><tr></tbody></template>x', '</template>x', '<template><tbody><tr><td>', '<template><thead><tbody></template>',
  ]);
  cases('form pointer', [
    '<form><form>x</form>y', '<form><div></form>x</div>', '<form>a</form><form>b', '<div><form></div>x</form>y', '<form><table><td><form>x', '</form>x',
    '<form><template><form>x</form></template>', '<template><form></form></template><form>',
  ]);
  cases('void, special and misc elements', [
    '<img src=x><image src=y>', '<br><wbr><area><embed><keygen><hr><input><param><track><source>', '<input type=HIDDEN><frameset>', '<frameset><frame></frameset>',
    '<frameset> x <frame> </frameset> y', '<frameset></frameset></html> z', '<frameset><noframes>x</noframes>', '<p>x<frameset>', '<frameset><frameset></frameset>',
    '<div><frameset>', '<body><frameset>', '<frameset></frameset><frameset>', '<frameset></frameset><noframes>n</noframes>', '<frameset></frameset></html><noframes>',
    '<object><p>x</object>y', '<marquee><b>x</marquee>y', '<applet>x</applet>', '<isindex>', '<menuitem>x', '<foo>a</foo>b', '<foo><div></foo>x', '<x:y>a</x:y>',
    '</div>x', '</foo>', '<button>a</button>', '<a><button><a>x', '<head></head><frame>x', '<frame>x', '<body><frame>x', '<image>', '</br>x', '<p></br>',
    '<math><mi><p>x</mi></math>', '<embed><p>', '<iframe>x</iframe>y', '<textarea><b></textarea>', '<p><xmp>x</xmp>', '<div><noscript>x</noscript></div>',
  ]);
  cases('foreign content', [
    '<svg><g><rect/></g></svg>x', 'a<svg>b</svg>c', '<svg><p>x</svg>', '<svg><b>x', '<svg><font color=red>x', '<svg><font>x</font></svg>y', '<math><p>x',
    '<svg><style><b>x</b></style></svg>', '<svg><title><b>x</b></title></svg>y', '<svg><desc><p>x</desc>y', '<svg><foreignObject><p>x</p></foreignObject>y</svg>z',
    '<svg><foreignObject><svg><p>x', '<math><mi><b>x</b></mi>y</math>', '<math><mi><mglyph>x</mi>', '<math><mtext><malignmark>x', '<math><annotation-xml encoding="text/html"><p>x</annotation-xml></math>',
    '<math><annotation-xml><p>x</annotation-xml></math>', '<math><annotation-xml><svg><p>x', '<math><annotation-xml encoding="APPLICATION/XHTML+XML"><div>x</div>',
    '<svg/>x', '<math/>x', '<svg><path/><circle></svg>x', '<svg></p>x', '<svg></br>x', '<svg><g></svg>x', '<svg><g></div>x', '<div><svg></div>x',
    '<svg><a><b>x', '<table><tr><svg><td>', '<svg><table>', '<p><svg><p>x', '<svg><foreignObject></svg>x', '<svg><foreignobject><table><td>x</table></foreignobject></svg>y',
    '<math><ms><svg><foreignObject><p>x', '<svg><desc><svg><g></desc>x', '<svg><title></title><p>x', '<svg>\0x</svg>', '<svg><script>x</script></svg>y',
    '<svg><textarea><b></textarea>', '<svg><![CDATA[a]]>b</svg>c', '<math><mo>x</math>y', '<svg><foreignObject><math><mi></foreignObject>x',
    '<b><svg><i>x</b>y', '<svg><g><foreignObject><div><svg><g></div>x', '<svg><SVG><Rect/>', '<svg><g></G>x</svg>y',
  ]);
  cases('text joined across what the raw tree leaves out', [
    'a<!--x-->b', 'a<svg></svg>b', 'a<math>m</math>b', 'a<template>t</template>b', '<b>x<!--c-->y</b>', '<table>a<svg></svg>b</table>',
  ]);
});

// a seeded random generator (mulberry32), so a failure reproduces
const random = (seed: number): (() => number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const TAGS = ('a b i u s em strong font nobr code big small tt p div span table tr td th tbody thead tfoot caption col colgroup ul ol li dl dt dd ' +
  'h1 h2 h3 select option optgroup svg math g foreignObject desc mi mtext annotation-xml template style title textarea script xmp noscript ' +
  'pre listing br img hr input form button html head body frameset frame object applet marquee ruby rt rp center blockquote x-y').split(' ');
const ATTRS = ['', ' class=x', ' id="1"', " href='&amp;x'", ' type=hidden', ' color=red', ' a=1 b=2', ' encoding=text/html', ' c=&notin', ' class=x id="1"'];
const TEXTS = ['x', ' ', '\n', 'a b', '&amp;', '&lt', '&#128;', '&notit;', '\0', '&#0;', 'y\r\nz', '<', '&'];
const OTHER = ['<!--c-->', '<!doctype html>', '<![CDATA[d]]>', '<?p?>', '</>', '<!x>', '<p/>', '<svg/>', '<br/>'];

function document(r: () => number): string {
  const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)];
  let html = r() < 0.3 ? '<!DOCTYPE html>' : '';
  const n = 1 + Math.floor(r() * 40);
  for (let i = 0; i < n; i++) {
    const x = r();
    if (x < 0.4) html += `<${pick(TAGS)}${pick(ATTRS)}>`;
    else if (x < 0.65) html += `</${pick(TAGS)}>`;
    else if (x < 0.9) html += pick(TEXTS);
    else html += pick(OTHER);
  }
  return html;
}

test('random documents', () => {
  const r = random(20261117);
  for (let i = 0; i < 4000; i++) same(document(r));
});

describe('the depth bound', () => {
  const depth = (n: RawNode): number => (n.type === 'text' ? 0 : 1 + Math.max(0, ...n.children.map(depth)));
  const parentsAreRight = (el: RawElement): boolean => el.children.every((c) => c.type === 'text' || (c.parent === el && parentsAreRight(c)));

  test('below the bound the tree is the browser\'s', () => {
    const html = '<div>'.repeat(250) + 'x' + '</div>'.repeat(250) + 'y';
    expect(plainOf(parseHTML(html))).toEqual(plainOf(reference(html)));
    expect(depth(parseHTML(html))).toBe(252); // html, body, 250 divs
  });

  test('deeper elements go beside the element at the bound', () => {
    const tree = parseHTML('<div>'.repeat(300) + 'x', { maxDepth: 10 });
    expect(depth(tree)).toBe(10);
    expect(parentsAreRight(tree)).toBe(true);
    let el = tree.children[1] as RawElement; // body
    for (let d = 3; d < 10; d++) el = el.children[0] as RawElement;
    // the element at depth 9 holds the divs that would have nested below it, one after the other
    expect(el.children.length).toBe(300 - 7);
    expect(plainOf(el.children[el.children.length - 1])).toEqual(['div', {}, 'x']);
  });

  test('the parse after a deep part goes on as the standard says', () => {
    const after = '<p>a<table><td>b</table><b>c<i>d</b>e';
    const body = parseHTML('<div>'.repeat(20) + '</div>'.repeat(20) + after, { maxDepth: 8 }).children[1] as RawElement;
    const expected = reference(after).children[1] as RawElement;
    expect(body.children.slice(1).map(plainOf)).toEqual(expected.children.map(plainOf));
  });

  test('random documents with a small bound: bounded, and the parse never fails', () => {
    const r = random(7);
    for (let i = 0; i < 2000; i++) {
      const max = 3 + Math.floor(r() * 8);
      const tree = parseHTML(document(r) + document(r), { maxDepth: max });
      expect(depth(tree)).toBeLessThanOrEqual(max);
      expect(parentsAreRight(tree)).toBe(true);
    }
  });

  test('the default bound is 256', () => {
    expect(depth(parseHTML('<div>'.repeat(1000)))).toBe(256);
  });
});

describe('linear time on hostile input', () => {
  const timed = (html: string): void => {
    const t = performance.now();
    parseHTML(html);
    expect(performance.now() - t, html.slice(0, 40)).toBeLessThan(1000);
  };
  test('100k unclosed <b>', () => timed('<b>'.repeat(100_000) + 'x'));
  test('100k distinct unclosed <b>', () => timed(Array.from({ length: 100_000 }, (_, i) => `<b id=${i}>`).join('')));
  test('100k <div>', () => timed('<div>'.repeat(100_000)));
  test('100k <div> in a <button> in a <p>', () => timed('<p><button>' + '<div>'.repeat(100_000) + '<li>'.repeat(10_000)));
  test('100k closed <div>', () => timed('<div>x</div>'.repeat(100_000)));
  test('1 MB of attributes', () => timed('<div ' + Array.from({ length: 100_000 }, (_, i) => `a${i}=v`).join(' ') + '>'));
  test('1 MB of attributes on formatting elements', () => timed(('<b ' + Array.from({ length: 1000 }, (_, i) => `a${i}=v`).join(' ') + '>').repeat(100)));
  test('a duplicated attribute', () => timed('<div ' + 'a=1 '.repeat(250_000) + '>'));
  test('&amp;&amp;…', () => timed('&amp;'.repeat(200_000) + '<a title="' + '&amp;'.repeat(200_000) + '">'));
  test('a long run after &', () => timed('&' + 'a'.repeat(1_000_000)));
  test('a table with 50k stray texts', () => timed('<table>' + 'x<td>'.repeat(1) + '<tr>' + 'x<!---->'.repeat(50_000) + '</table>'));
  test('a table with 50k stray elements', () => timed('<p>'.repeat(1000) + '<table>' + '<i>x</i>'.repeat(50_000)));
  test('misnested formatting', () => timed('<b><p>x</b>'.repeat(50_000)));
  test('100k <table></table> deep in divs', () => timed('<div>'.repeat(300) + '<table></table>'.repeat(100_000)));
  test('unclosed comments, raw text and script', () => {
    timed('<!--' + 'x'.repeat(1_000_000));
    timed('<style>' + '</styl'.repeat(100_000));
    timed('<script>' + '<!--<script>'.repeat(100_000));
    timed('<textarea>' + '&amp;</textare'.repeat(100_000));
  });
  test('100k <svg> elements', () => timed('<svg>' + '<g>'.repeat(100_000) + '</x>'.repeat(100_000)));
  test('100k <a>', () => timed('<a>x'.repeat(100_000)));
  test('100k <object>', () => timed('<object>'.repeat(100_000) + '<b>x'.repeat(1000)));
});

test('the entity table is up to date', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/build-entities.mjs', import.meta.url)), '--check']);
});

test('sinter/parser imports nothing outside itself', () => {
  const dir = new URL('../sinter/parser/', import.meta.url);
  for (const file of readdirSync(dir)) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    for (const [, from] of source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm)) {
      // a type-only import of the raw tree's types is erased; any other import stays in the folder
      const typeOnly = new RegExp(`import type [^;]*'${from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'`).test(source);
      expect(from.startsWith('./') || (typeOnly && from === '../raw.js'), `${file}: ${from}`).toBe(true);
    }
  }
});
