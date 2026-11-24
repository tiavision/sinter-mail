import { describe, expect, test } from 'vitest';
import { attr, type RawElement } from '../sinter/raw.js';
import { resolve, resolveStyles } from '../sinter/css/index.js';
import { parseComponents, tokenize } from '../sinter/css/tokenize.js';
import { parseDeclarations, parseStylesheet } from '../sinter/css/parse.js';
import { matchMedia } from '../sinter/css/media.js';
import { expand } from '../sinter/css/values.js';
import { dimension, legacyColor, legacyFontSize } from '../sinter/css/hints.js';
import { indexTree, matches, parseSelectorList } from '../sinter/css/selectors.js';
import { reference } from './reference.js';
import type { Style } from '../sinter/sinter.types.js';

/** the resolved styles of a document, by element id */
function styles(html: string, media: 'wide' | 'narrow' = 'wide'): Record<string, Style> {
  const root = reference(html);
  const map = resolveStyles(root, { media });
  const out: Record<string, Style> = {};
  const walk = (el: RawElement) => {
    const id = attr(el, 'id');
    if (id !== null) out[id] = map.get(el) ?? {};
    for (const c of el.children) if (c.type === 'element') walk(c);
  };
  walk(root);
  return out;
}
const one = (html: string, media: 'wide' | 'narrow' = 'wide') => styles(html, media).x;
const tokenizeCV = (s: string) => parseComponents(s);
/** one declaration's longhands, as an object */
const ex = (name: string, value: string) => {
  const a = expand(name, value);
  return a ? Object.fromEntries(a) : null;
};

describe('tokenizer', () => {
  test('identifiers, escapes, strings, numbers, dimensions', () => {
    const t = tokenize('a\\62 c "x\\"y" 12.5px -3 +.5e2% #f00 #1a @media url( x.png ) u+1 --x <!-- -->');
    expect(t.filter((x) => x.t !== 'ws')).toEqual([
      { t: 'ident', v: 'abc' },
      { t: 'string', v: 'x"y' },
      { t: 'dimension', n: 12.5, int: false, s: '12.5', unit: 'px' },
      { t: 'number', n: -3, int: true, s: '-3' },
      { t: 'percentage', n: 50, s: '+.5e2' },
      { t: 'hash', v: 'f00', id: true },
      { t: 'hash', v: '1a', id: false },
      { t: 'at-keyword', v: 'media' },
      { t: 'url', v: 'x.png' },
      { t: 'ident', v: 'u' },
      { t: 'number', n: 1, int: true, s: '+1' },
      { t: 'ident', v: '--x' },
      { t: 'cdo' },
      { t: 'cdc' },
    ]);
  });
  test('comments vanish; escapes of NUL, surrogates and past U+10FFFF are U+FFFD', () => {
    expect(tokenize('a/* x */b')).toEqual([{ t: 'ident', v: 'a' }, { t: 'ident', v: 'b' }]);
    expect(tokenize('\\0 \\d800 \\110000')).toEqual([{ t: 'ident', v: '���' }]);
    expect(tokenize('a/* unterminated')).toEqual([{ t: 'ident', v: 'a' }]);
  });
  test('bad strings, bad urls, a quoted url() as a function', () => {
    expect(tokenize('"a\nb"').map((x) => x.t)).toEqual(['bad-string', 'ws', 'ident', 'string']);
    expect(tokenize('url(a b)')).toEqual([{ t: 'bad-url' }]);
    expect(tokenize('url( "a")').map((x) => x.t)).toEqual(['function', 'ws', 'string', ')']);
    expect(tokenize('"line\\\ncontinued"')).toEqual([{ t: 'string', v: 'linecontinued' }]);
  });
  test('an unterminated string ends at the end of the input', () => {
    expect(tokenize('"abc')).toEqual([{ t: 'string', v: 'abc' }]);
  });
});

describe('stylesheet parser', () => {
  test('rules, at-rules, error recovery', () => {
    const r = parseStylesheet('@import "x.css"; a { color: red; ; b: } @media screen { p { x: y } } }} c { d: e !important }');
    expect(r.map((x) => (x.t === 'at' ? '@' + x.name : 'rule'))).toEqual(['@import', 'rule', '@media', 'rule']);
    const last = r[3];
    expect(last.t === 'style' && last.declarations).toEqual([{ name: 'd', value: [{ t: 'ident', v: 'e' }], important: true }]);
  });
  test('declarations: hacks and junk are dropped up to the next semicolon', () => {
    const d = parseDeclarations('*zoom: 1; _height: 1px; color: red !ie; COLOR: Blue ! IMPORTANT; {x} width: 1px; margin:0');
    expect(d.map((x) => [x.name, x.important])).toEqual([['_height', false], ['color', false], ['color', true], ['width', false], ['margin', false]]);
  });
  test('a nested rule is skipped whole', () => {
    const r = parseStylesheet('a { color: red; .b { color: blue } width: 1px }');
    expect(r[0].t === 'style' && r[0].declarations.map((d) => d.name)).toEqual(['color', 'width']);
  });
});

describe('values', () => {
  test('lengths: the units kept, unitless 0, no viewport units, no math, no negatives where they reach out', () => {
    expect(ex('width', '10PX')).toEqual({ width: '10px' });
    expect(ex('width', '1.5em')).toEqual({ width: '1.5em' });
    expect(ex('width', '50%')).toEqual({ width: '50%' });
    expect(ex('width', '0')).toEqual({ width: '0' });
    expect(ex('width', '10')).toBeNull();
    expect(ex('width', '10vw')).toBeNull();
    expect(ex('width', 'calc(100% - 10px)')).toBeNull();
    expect(ex('width', '-10px')).toBeNull();
    expect(ex('margin-left', '-10px')).toEqual({ 'margin-left': '0' });
    expect(ex('margin', '-10px 0 5px')).toEqual({ 'margin-top': '0', 'margin-right': '0', 'margin-bottom': '5px', 'margin-left': '0' });
    // a small negative margin-bottom is tracked, for the cascade to write as 0 or as an image's vertical-align
    expect(ex('margin-bottom', '-6px')).toEqual({ 'margin-bottom': '-6px' });
    expect(ex('margin-bottom', '-1em')).toEqual({ 'margin-bottom': '-1em' });
    expect(ex('margin-bottom', '-17px')).toEqual({ 'margin-bottom': '0' });
    expect(ex('margin-bottom', '-2em')).toEqual({ 'margin-bottom': '0' });
    expect(ex('margin-bottom', '-10%')).toEqual({ 'margin-bottom': '0' });
    expect(ex('margin-bottom', '10%')).toEqual({ 'margin-bottom': '10%' });
    expect(ex('margin', '-6px')).toEqual({ 'margin-top': '0', 'margin-right': '0', 'margin-bottom': '-6px', 'margin-left': '0' });
    expect(ex('margin', '5px 10px -6px')).toEqual({ 'margin-top': '5px', 'margin-right': '10px', 'margin-bottom': '-6px', 'margin-left': '10px' });
    expect(ex('padding', '-1px')).toBeNull();
    expect(ex('text-indent', '-9999px')).toEqual({ 'text-indent': '0' });
    expect(ex('letter-spacing', '-0.5px')).toEqual({ 'letter-spacing': '-0.5px' });
    expect(ex('letter-spacing', '-100px')).toBeNull();
    expect(ex('max-width', 'none')).toEqual({ 'max-width': 'none' });
    expect(ex('width', 'var(--w)')).toBeNull();
  });
  test('colours', () => {
    expect(ex('color', 'RED')).toEqual({ color: 'red' });
    expect(ex('color', '#ABC')).toEqual({ color: '#abc' });
    expect(ex('color', '#abcd')).toEqual({ color: '#abcd' });
    expect(ex('color', '#abcde')).toBeNull();
    expect(ex('color', 'rgb(1, 2, 300)')).toEqual({ color: 'rgb(1, 2, 255)' });
    expect(ex('color', 'rgba(1,2,3,.5)')).toEqual({ color: 'rgba(1, 2, 3, 0.5)' });
    expect(ex('color', 'rgb(10% 20% 30% / 50%)')).toEqual({ color: 'rgba(25.5, 51, 76.5, 0.5)' });
    expect(ex('color', 'rgb(10%, 2, 3)')).toBeNull();
    expect(ex('color', 'hsl(120deg 50% 50%)')).toEqual({ color: 'hsl(120, 50%, 50%)' });
    expect(ex('color', 'hsla(0.5turn, 10%, 20%, 0.3)')).toEqual({ color: 'hsla(180, 10%, 20%, 0.3)' });
    expect(ex('color', 'transparent')).toEqual({ color: 'transparent' });
    expect(ex('color', 'CurrentColor')).toEqual({ color: 'currentcolor' });
    expect(ex('color', 'lab(50 20 30)')).toBeNull();
    expect(ex('color', 'notacolor')).toBeNull();
    expect(ex('color', 'expression(alert(1))')).toBeNull();
  });
  test('font-family: re-quoted, generics bare, escapes decoded', () => {
    expect(ex('font-family', 'Arial, "Helvetica Neue", sans-serif')).toEqual({ 'font-family': '"Arial", "Helvetica Neue", sans-serif' });
    expect(ex('font-family', 'Times   New  Roman')).toEqual({ 'font-family': '"Times New Roman"' });
    expect(ex('font-family', '"\\5FAE\\8F6F\\96C5\\9ED1"')).toEqual({ 'font-family': '"微软雅黑"' });
    expect(ex('font-family', "'a\"b', c")).toEqual({ 'font-family': `'a"b', "c"` });
    expect(ex('font-family', `"a\\"b'c", d`)).toEqual({ 'font-family': '"d"' });
    expect(ex('font-family', 'initial, serif')).toBeNull();
    expect(ex('font-family', 'a,')).toBeNull();
    expect(ex('font-family', '"x\\a y"')).toBeNull();
    expect(ex('font-family', '"url(x)", serif')).toEqual({ 'font-family': 'serif' });
  });
  test('keywords per property, CSS-wide keywords kept, revert not', () => {
    expect(ex('display', 'inline-block')).toEqual({ display: 'inline-block' });
    expect(ex('display', 'contents')).toBeNull();
    expect(ex('display', 'TABLE-CELL')).toEqual({ display: 'table-cell' });
    expect(ex('color', 'inherit')).toEqual({ color: 'inherit' });
    expect(ex('margin', 'unset')).toEqual({ 'margin-top': 'unset', 'margin-right': 'unset', 'margin-bottom': 'unset', 'margin-left': 'unset' });
    expect(ex('color', 'revert')).toBeNull();
    expect(ex('font-weight', '700')).toEqual({ 'font-weight': '700' });
    expect(ex('font-weight', '0')).toBeNull();
    expect(ex('line-height', '1.4')).toEqual({ 'line-height': '1.4' });
    expect(ex('line-height', '-1')).toBeNull();
    expect(ex('opacity', '1.5')).toEqual({ opacity: '1' });
    expect(ex('opacity', '50%')).toEqual({ opacity: '0.5' });
    expect(ex('position', 'fixed')).toBeNull();
    expect(ex('-webkit-text-size-adjust', '100%')).toBeNull();
    expect(ex('mso-line-height-rule', 'exactly')).toBeNull();
    expect(ex('list-style-type', '"-"')).toEqual({ 'list-style-type': '"-"' });
  });
  test('shorthands', () => {
    expect(ex('margin', '0 auto')).toEqual({ 'margin-top': '0', 'margin-right': 'auto', 'margin-bottom': '0', 'margin-left': 'auto' });
    expect(ex('padding', '1px 2px 3px')).toEqual({ 'padding-top': '1px', 'padding-right': '2px', 'padding-bottom': '3px', 'padding-left': '2px' });
    expect(ex('margin', '1px 2px 3px 4px 5px')).toBeNull();
    expect(ex('border', '1px solid #ccc')).toMatchObject({ 'border-top-width': '1px', 'border-left-style': 'solid', 'border-bottom-color': '#ccc' });
    expect(ex('border', 'none')).toMatchObject({ 'border-top-width': 'medium', 'border-top-style': 'none', 'border-top-color': 'currentcolor' });
    expect(ex('border-top', 'red 2px')).toEqual({ 'border-top-width': '2px', 'border-top-style': 'none', 'border-top-color': 'red' });
    expect(ex('border', '1px solid solid')).toBeNull();
    expect(ex('border-color', 'red blue')).toEqual({ 'border-top-color': 'red', 'border-right-color': 'blue', 'border-bottom-color': 'red', 'border-left-color': 'blue' });
    expect(ex('border-radius', '4px')).toEqual({ 'border-top-left-radius': '4px', 'border-top-right-radius': '4px', 'border-bottom-right-radius': '4px', 'border-bottom-left-radius': '4px' });
    expect(ex('border-radius', '1px 2px / 3px')).toEqual({ 'border-top-left-radius': '1px 3px', 'border-top-right-radius': '2px 3px', 'border-bottom-right-radius': '1px 3px', 'border-bottom-left-radius': '2px 3px' });
    expect(ex('background', '#fff url(x.png) no-repeat center / cover')).toEqual({ 'background-color': '#fff' });
    expect(ex('background', 'url(x.png)')).toEqual({ 'background-color': 'transparent' });
    expect(ex('background', 'red, url(x.png)')).toBeNull();
    expect(ex('background', 'blurple')).toBeNull();
    expect(ex('font', 'italic bold 12px/1.5 Arial, sans-serif')).toEqual({ 'font-style': 'italic', 'font-variant': 'normal', 'font-weight': 'bold', 'font-size': '12px', 'line-height': '1.5', 'font-family': '"Arial", sans-serif' });
    expect(ex('font', '14px Georgia')).toMatchObject({ 'line-height': 'normal', 'font-weight': 'normal' });
    expect(ex('font', 'caption')).toBeNull();
    expect(ex('font', 'bold Arial')).toBeNull();
    expect(ex('list-style', 'none')).toEqual({ 'list-style-type': 'none', 'list-style-position': 'outside' });
    expect(ex('list-style', 'square inside url(x.png)')).toEqual({ 'list-style-type': 'square', 'list-style-position': 'inside' });
    expect(ex('overflow', 'hidden')).toEqual({ 'overflow-x': 'hidden', 'overflow-y': 'hidden' });
    expect(ex('text-decoration', 'underline dotted red')).toEqual({ 'text-decoration-line': 'underline', 'text-decoration-style': 'dotted', 'text-decoration-color': 'red' });
    expect(ex('text-decoration', 'none')).toEqual({ 'text-decoration-line': 'none', 'text-decoration-style': 'solid', 'text-decoration-color': 'currentcolor' });
    expect(ex('word-wrap', 'break-word')).toEqual({ 'overflow-wrap': 'break-word' });
    expect(ex('border-spacing', '2px 4px')).toEqual({ 'border-spacing': '2px 4px' });
  });
});

describe('selectors', () => {
  const doc = reference(
    '<div id=a class="x y"><p id=b class=x>1</p><p id=c lang=en-US data-k="Foo bar">2</p><span id=d></span><p id=e><a id=f href=#>l</a><a id=g>m</a></p></div>',
  );
  const all = indexTree(doc);
  const ids = (sel: string) => {
    const list = parseSelectorList(tokenizeCV(sel));
    if (!list) return null;
    return all.filter((e) => list.some((s) => matches(s, e, { left: Infinity }))).map((e) => attr(e.el, 'id')).filter(Boolean).join(' ');
  };
  test('type, class, id, universal, attributes', () => {
    expect(ids('P')).toBe('b c e');
    expect(ids('.x')).toBe('a b');
    expect(ids('.X')).toBe('');
    expect(ids('#c')).toBe('c');
    expect(ids('div *')).toBe('b c d e f g');
    expect(ids('[lang|=en]')).toBe('c');
    expect(ids('[data-k~=bar]')).toBe('c');
    expect(ids('[data-k^="Foo"]')).toBe('c');
    expect(ids('[data-k^=foo]')).toBe('');
    expect(ids('[data-k^=foo i]')).toBe('c');
    expect(ids('[data-k$=bar][data-k*="o b"]')).toBe('c');
    expect(ids('[class]')).toBe('a b');
  });
  test('combinators', () => {
    expect(ids('div > p')).toBe('b c e');
    expect(ids('div a')).toBe('f g');
    expect(ids('div > a')).toBe('');
    expect(ids('#b + p')).toBe('c');
    expect(ids('#b ~ p')).toBe('c e');
    expect(ids('#b ~ * a')).toBe('f g');
  });
  test('structural pseudo-classes', () => {
    expect(ids('p:first-child')).toBe('b');
    expect(ids('div > :last-child')).toBe('e');
    expect(ids('a:only-child')).toBe('');
    expect(ids(':nth-child(2n+1)')).toBe('a b d f');
    expect(ids('div > :nth-child(-n+2)')).toBe('b c');
    expect(ids('p:nth-of-type(2)')).toBe('c');
    expect(ids('p:nth-last-of-type(1)')).toBe('e');
    expect(ids(':nth-child(odd of p)')).toBe('b e');
    expect(ids('span:empty')).toBe('d');
    expect(ids(':root')).toBe('');
    expect(ids('a:link')).toBe('f');
    expect(ids('p:not(.x)')).toBe('c e');
    expect(ids(':is(#b, #c)')).toBe('b c');
    expect(ids(':where(#d)')).toBe('d');
  });
  test('valid but unmatchable selectors drop only themselves; an invalid one drops the list', () => {
    expect(ids('a:hover, #b')).toBe('b');
    expect(ids('p::before, #c')).toBe('c');
    expect(ids('p:first-letter')).toBe('');
    expect(ids('#b, p:frobnicate')).toBeNull();
    expect(ids('#b, ::-moz-selection')).toBeNull();
    expect(ids('#b,')).toBeNull();
    expect(ids(':is(#b, :frobnicate)')).toBe('b');
    expect(ids('ns|p')).toBeNull();
    expect(ids('*|p')).toBe('b c e');
  });
  test('specificity', () => {
    const sp = (s: string) => parseSelectorList(tokenizeCV(s))![0].specificity;
    expect(sp('#a .b c')).toBe(1_001_001);
    expect(sp(':is(#a, .b) c')).toBe(1_000_001);
    expect(sp(':where(#a) c')).toBe(1);
    expect(sp(':not(.a, #b)')).toBe(1_000_000);
    expect(sp(':nth-child(2 of .a)')).toBe(2_000);
    expect(sp('a[href]:first-child')).toBe(2_001);
  });
});

describe('media', () => {
  test('types, features, ranges, logic, at both widths', () => {
    const both = (q: string) => [matchMedia(q, 'wide'), matchMedia(q, 'narrow')];
    expect(both('')).toEqual([true, true]);
    expect(both('screen')).toEqual([true, true]);
    expect(both('print')).toEqual([false, false]);
    expect(both('only screen and (max-width: 600px)')).toEqual([false, true]);
    expect(both('screen and (min-width:601px)')).toEqual([true, false]);
    expect(both('(max-width: 37.5em)')).toEqual([false, true]);
    expect(both('(width <= 600px)')).toEqual([false, true]);
    expect(both('(400px < width < 900px)')).toEqual([true, false]);
    expect(both('(orientation: portrait)')).toEqual([false, true]);
    expect(both('(prefers-color-scheme: dark)')).toEqual([false, false]);
    expect(both('(prefers-color-scheme: light)')).toEqual([true, true]);
    expect(both('not print')).toEqual([true, true]);
    expect(both('not screen and (max-width: 600px)')).toEqual([true, false]);
    expect(both('print, (max-width: 480px)')).toEqual([false, true]);
    expect(both('(max-width: 600px) or (min-width: 700px)')).toEqual([true, true]);
    expect(both('(-webkit-min-device-pixel-ratio: 2)')).toEqual([false, false]);
    expect(both('(unknown-feature: 1)')).toEqual([false, false]);
    expect(both('not (unknown-feature: 1)')).toEqual([false, false]);
    expect(both('screen and')).toEqual([false, false]);
    expect(both('(max-width: 600px) and screen')).toEqual([false, false]);
    expect(both('(max-width: 50vw)')).toEqual([false, false]);
  });
  test('@media rules and the media attribute in the cascade', () => {
    const html = `<style>p { color: red } @media (max-width: 600px) { p { color: blue } @media screen { p { width: 1px } } }</style>
      <style media="print">p { font-size: 99px }</style><style media="(max-width: 480px)">p { height: 2px }</style><p id=x>`;
    expect(one(html)).toEqual({ color: 'red' });
    expect(one(html, 'narrow')).toEqual({ color: 'blue', width: '1px', height: '2px' });
  });
});

describe('colour schemes', () => {
  const resolved = (html: string) => resolve(reference(html), { media: 'wide' });
  test('prefers-color-scheme in both schemes', () => {
    expect(matchMedia('(prefers-color-scheme: dark)', 'wide', 'dark')).toBe(true);
    expect(matchMedia('(prefers-color-scheme: light)', 'wide', 'dark')).toBe(false);
    expect(matchMedia('(prefers-color-scheme: dark) and (max-width: 600px)', 'narrow', 'dark')).toBe(true);
    expect(matchMedia('(prefers-color-scheme: dark) and (max-width: 600px)', 'wide', 'dark')).toBe(false);
  });
  test('colours a dark rule changes are light-dark(); what it sets that a light one does not, the initial value in light', () => {
    const s = styles(`<style>p { color: #222; background-color: #fff; width: 10px }
      @media (prefers-color-scheme: dark) { p { color: #eee !important; background-color: #111; width: 20px; border-left: 1px solid #333 } }
      .t { text-decoration: underline #00f } @media (prefers-color-scheme: dark) { .t { text-decoration-color: #9cf } }</style>
      <p id=x>a</p><p id=y class=t>b</p>`);
    expect(s.x).toMatchObject({
      color: 'light-dark(#222, #eee)', 'background-color': 'light-dark(#fff, #111)', width: '10px',
      'border-left-color': 'light-dark(currentcolor, #333)',
    });
    // a non-colour property keeps its light value: light-dark() takes colours only
    expect(s.x['border-left-width']).toBeUndefined();
    expect(s.y).toMatchObject({ 'text-decoration': 'underline light-dark(#00f, #9cf)' });
  });
  test('<style media>, a rule for light only, nesting', () => {
    expect(one(`<style media="(prefers-color-scheme: dark)">p { color: white }</style><p id=x>`)).toEqual({ color: 'light-dark(currentcolor, white)' });
    expect(one(`<style>@media (prefers-color-scheme: light) { p { color: navy } }</style><p id=x>`)).toEqual({ color: 'light-dark(navy, currentcolor)' });
    expect(one(`<style>@media (max-width: 600px) { @media (prefers-color-scheme: dark) { p { color: white } } }</style><p id=x>`)).toEqual({});
    expect(one(`<style>@media screen { @media (prefers-color-scheme: dark) { p { color: white } } }</style><p id=x>`)).toEqual({ color: 'light-dark(currentcolor, white)' });
  });
  test('a CSS-wide keyword in one scheme keeps the light value', () => {
    expect(one(`<style>p { color: red } @media (prefers-color-scheme: dark) { p { color: inherit } }</style><p id=x>`)).toEqual({ color: 'red' });
  });
  test('dark: whether a colour changes', () => {
    expect(resolved(`<style>@media (prefers-color-scheme: dark) { p { color: white } }</style><p>`).dark).toBe(true);
    expect(resolved(`<style>@media (prefers-color-scheme: dark) { p { width: 1px } } p { color: red }</style><p>`).dark).toBe(false);
    expect(resolved(`<style>@media (prefers-color-scheme: dark) { .none { color: white } }</style><p>`).dark).toBe(false);
    expect(resolved(`<p style="color: red">`).dark).toBe(false);
  });
  test('colorScheme: the metas, and the property on <html> and <body>', () => {
    const cs = (html: string) => resolved(html).colorScheme;
    expect(cs('<p>')).toEqual([]);
    expect(cs('<meta name="color-scheme" content="light dark"><p>')).toEqual(['light', 'dark']);
    expect(cs('<meta name="supported-color-schemes" content="dark light"><p>')).toEqual(['light', 'dark']);
    expect(cs('<meta name="Color-Scheme" content="only light"><p>')).toEqual(['light']);
    expect(cs('<meta name="color-scheme" content="normal"><p>')).toEqual([]);
    expect(cs('<meta name="color-scheme" content="light, dark"><p>')).toEqual([]);
    expect(cs('<html style="color-scheme: light dark"><p>')).toEqual(['light', 'dark']);
    expect(cs('<style>:root { color-scheme: dark }</style><p>')).toEqual(['dark']);
    expect(cs('<style>body { color-scheme: light dark }</style><p>')).toEqual(['light', 'dark']);
    // on another element it says nothing about the email, and is never kept
    expect(cs('<p style="color-scheme: dark">')).toEqual([]);
    expect(one('<p id=x style="color-scheme: dark; color: red">')).toEqual({ color: 'red' });
  });
  test('color-scheme values', () => {
    expect(ex('color-scheme', 'light dark')).toEqual({ 'color-scheme': 'light dark' });
    expect(ex('color-scheme', 'dark light only')).toEqual({ 'color-scheme': 'light dark' });
    expect(ex('color-scheme', 'only')).toBeNull();
    expect(ex('color-scheme', 'light only dark')).toBeNull();
    expect(ex('color-scheme', 'sepia')).toEqual({ 'color-scheme': 'normal' });
    expect(ex('color-scheme', 'normal light')).toBeNull();
  });
});

describe('the cascade', () => {
  test('specificity, then order; !important after normal; the style attribute above rules and !important above it', () => {
    const s = styles(`<style>
      #x { color: red } p { color: blue; width: 1px !important } .c { color: green; height: 3px }
      p.c { height: 4px } .c { font-size: 10px !important }
      </style><p id=x class=c style="width: 2px; height: 5px; font-size: 20px; line-height: 2 !important">`);
    expect(s.x).toEqual({ color: 'red', 'line-height': '2', 'font-size': '10px', width: '1px', height: '5px' });
  });
  test('a small negative margin-bottom lowers an inline image by vertical-align, never as a margin', () => {
    // a shop's card logo, centred on its line by the margin (made up)
    const icon = 'height: 24px; display: inline-block; margin-top: 5px; margin-bottom: -6px';
    expect(one(`<p><img id=x style="${icon}">ends with 1234</p>`)).toEqual({
      display: 'inline-block', 'vertical-align': '-6px', height: '24px', 'margin-top': '5px', 'margin-bottom': '0',
    });
    expect(one('<img id=x style="margin: 0 0 -0.5em">')).toMatchObject({ 'vertical-align': '-0.5em', 'margin-bottom': '0' });
    expect(one('<img id=x style="display: inline; margin-bottom: -6px">')).toMatchObject({ 'vertical-align': '-6px' });
    expect(one('<img id=x style="vertical-align: baseline; margin-bottom: -6px">')).toMatchObject({ 'vertical-align': '-6px' });
    // not where vertical-align would not do what the margin does: written as 0, as every negative margin
    const zero = { 'margin-bottom': '0' };
    expect(one('<img id=x style="margin-bottom: -6px; display: block">')).toEqual({ display: 'block', ...zero });
    expect(one('<img id=x style="margin-bottom: -6px; float: left">')).toEqual({ float: 'left', ...zero });
    expect(one('<img id=x style="margin-bottom: -6px; vertical-align: middle">')).toEqual({ 'vertical-align': 'middle', ...zero });
    expect(one('<img id=x align=middle style="margin-bottom: -6px">')).toEqual({ 'vertical-align': 'middle', ...zero });
    expect(one('<img id=x style="margin-bottom: -6px; display: inherit">')).toEqual({ display: 'inherit', ...zero });
    expect(one('<img id=x style="margin-bottom: -20px">')).toEqual(zero);
    expect(one('<img id=x style="margin-bottom: -10%">')).toEqual(zero);
    // an inline-block with text in it sits on its last line's baseline: the margin does not move it
    expect(one('<span id=x style="display: inline-block; margin-bottom: -6px">x</span>')).toEqual({ display: 'inline-block', ...zero });
    expect(one('<p id=x style="margin-bottom: -6px">x</p>')).toEqual(zero);
    // the margin cascades as margin-bottom: a later or more important one replaces it
    expect(one('<style>img { margin-bottom: -6px }</style><img id=x style="margin-bottom: 2px">')).toEqual({ 'margin-bottom': '2px' });
    expect(one('<style>img { margin: 0 !important }</style><img id=x style="margin-bottom: -6px">')).toEqual({
      'margin-top': '0', 'margin-right': '0', 'margin-bottom': '0', 'margin-left': '0',
    });
    expect(one('<img id=x style="margin-bottom: -6px; margin-bottom: unset">')).toEqual({ 'margin-bottom': 'unset' });
    // one inline style on an image and on a span: the cache shares styles by inline text, not by tag
    const s = styles('<img id=a style="margin-bottom: -6px"><span id=b style="margin-bottom: -6px">x</span><img id=c style="margin-bottom: -6px">');
    expect(s.a).toEqual({ 'vertical-align': '-6px', ...zero });
    expect(s.b).toEqual(zero);
    expect(s.c).toEqual(s.a);
  });
  test('inline !important beats author !important', () => {
    expect(one('<style>p { color: red !important }</style><p id=x style="color: blue !important">')).toEqual({ color: 'blue' });
  });
  test('a shorthand and a longhand by order and importance', () => {
    expect(one('<p id=x style="margin: 0; margin-left: 5px; padding-top: 1px; padding: 2px">')).toEqual({
      'margin-top': '0', 'margin-right': '0', 'margin-bottom': '0', 'margin-left': '5px',
      'padding-top': '2px', 'padding-right': '2px', 'padding-bottom': '2px', 'padding-left': '2px',
    });
    expect(one('<style>p { padding-top: 9px !important }</style><p id=x style="padding: 2px">')).toMatchObject({ 'padding-top': '9px', 'padding-left': '2px' });
  });
  test('an invalid declaration leaves the earlier one', () => {
    expect(one('<p id=x style="color: red; color: var(--x); width: 10px; width: calc(1px + 2px)">')).toEqual({ color: 'red', width: '10px' });
  });
  test('text-decoration and overflow are joined from their longhands', () => {
    expect(one('<p id=x style="text-decoration: underline; text-decoration-color: red; overflow-x: hidden; overflow-y: clip">')).toEqual({ 'text-decoration': 'underline red', overflow: 'hidden' });
    expect(one('<p id=x style="overflow-x: hidden">')).toEqual({});
    expect(one('<a id=x style="text-decoration: none">')).toEqual({ 'text-decoration': 'none' });
  });
  test('<style> with another type, rules that set nothing kept', () => {
    expect(one('<style type="text/less">p { color: red }</style><style type=" TEXT/CSS ">p { width: 1px }</style><p id=x>')).toEqual({ width: '1px' });
  });
  test('the body style and every element of the document are resolved', () => {
    const s = styles('<html id=h><body id=b bgcolor=#eee style="font-family: Arial"><style>body { color: #333 } :root { color: red }</style>');
    expect(s.b).toEqual({ color: '#333', 'font-family': '"Arial"', 'background-color': '#eeeeee' });
    expect(s.h).toEqual({ color: 'red' });
  });
  test('class names in a style block, inherited structure untouched', () => {
    const s = styles(`<style>.wrap td.cell { padding: 10px } .wrap .cell a { color: #0a0 } tr:first-child td { font-weight: bold }</style>
      <table class=wrap><tr><td class=cell id=c><a id=l href=#>x</a></td></tr></table>`);
    expect(s.c).toEqual({ 'font-weight': 'bold', 'padding-top': '10px', 'padding-right': '10px', 'padding-bottom': '10px', 'padding-left': '10px' });
    expect(s.l).toEqual({ color: '#0a0' });
  });
});

describe('presentational hints', () => {
  test('legacy colours', () => {
    expect(legacyColor('#abc')).toBe('#aabbcc');
    expect(legacyColor('ffffff')).toBe('#ffffff');
    expect(legacyColor(' Red ')).toBe('red');
    expect(legacyColor('transparent')).toBeNull();
    expect(legacyColor('')).toBeNull();
    expect(legacyColor('chucknorris')).toBe('#c00000');
    expect(legacyColor('#1234567890')).toBe('#125690');
    expect(legacyColor('#f')).toBe('#0f0000');
  });
  test('dimensions and font sizes', () => {
    expect(dimension('600')).toBe('600px');
    expect(dimension(' 50 %')).toBe('50px');
    expect(dimension('50%')).toBe('50%');
    expect(dimension('100px')).toBe('100px');
    expect(dimension('abc')).toBeNull();
    expect(dimension('0')).toBe('0');
    expect(dimension('0', true)).toBeNull();
    expect(legacyFontSize('+2')).toBe('24px');
    expect(legacyFontSize('7')).toBe('48px');
    expect(legacyFontSize('0')).toBe('10px');
    expect(legacyFontSize('-1')).toBe('13px');
    expect(legacyFontSize('x')).toBeNull();
  });
  test('tables: bgcolor, width, align, border, cellpadding, cellspacing, valign', () => {
    const s = styles(`<table id=t border=1 cellpadding=4 cellspacing=0 width=600 align=center bgcolor=ffffff>
      <tbody id=s valign=top><tr id=r align=right><td id=a nowrap>1</td><td id=b valign=bottom width=0 height=20 bgcolor=red>2</td></tr></tbody></table>`);
    expect(s.t).toMatchObject({ width: '600px', 'margin-left': 'auto', 'margin-right': 'auto', 'background-color': '#ffffff', 'border-spacing': '0px', 'border-top-width': '1px', 'border-top-style': 'outset' });
    expect(s.r).toEqual({ 'text-align': '-webkit-right' });
    expect(s.s).toEqual({ 'vertical-align': 'top' });
    expect(s.a).toMatchObject({ 'padding-top': '4px', 'border-left-width': '1px', 'border-left-style': 'inset', 'border-left-color': 'inherit', 'vertical-align': 'top', 'white-space': 'nowrap' });
    expect(s.b).toMatchObject({ 'vertical-align': 'bottom', height: '20px', 'background-color': 'red' });
    expect(s.b.width).toBeUndefined();
  });
  test('author rules beat hints', () => {
    expect(one('<style>td { padding: 0 }</style><table cellpadding=10><tr><td id=x>')).toEqual({ 'padding-top': '0', 'padding-right': '0', 'padding-bottom': '0', 'padding-left': '0' });
  });
  test('<font>, <center>, div align, img, hr, body', () => {
    expect(one('<font id=x color=ff0000 face="Arial, Helvetica" size=+1>')).toEqual({ color: '#ff0000', 'font-family': '"Arial", "Helvetica"', 'font-size': '18px' });
    expect(one('<center id=x>')).toEqual({ 'text-align': '-webkit-center' });
    expect(one('<div id=x align=center>')).toEqual({ 'text-align': '-webkit-center' });
    expect(one('<h1 id=x align=center>')).toEqual({ 'text-align': 'center' });
    expect(one('<img id=x width=100 height=50% align=left border=0 hspace=5>')).toEqual({
      width: '100px', height: '50%', float: 'left', 'vertical-align': 'top', 'margin-left': '5px', 'margin-right': '5px',
      'border-top-width': '0', 'border-right-width': '0', 'border-bottom-width': '0', 'border-left-width': '0',
      'border-top-style': 'solid', 'border-right-style': 'solid', 'border-bottom-style': 'solid', 'border-left-style': 'solid',
    });
    expect(one('<hr id=x size=4 color=red>')).toMatchObject({ height: '2px', 'background-color': 'red', 'border-top-style': 'solid' });
    expect(styles('<body id=x text=#333 link=blue bgcolor=white><a id=a href=#>').x).toEqual({ color: '#333333', 'background-color': 'white' });
    expect(styles('<body link=blue><a id=a href=#>x</a><a id=n>y</a>').a).toEqual({ color: 'blue' });
  });
});

describe('safety', () => {
  test('no value ever has a backslash, url(, image( or a disallowed function', () => {
    const hostile = `<style>
      p { color: \\72 ed; font-family: "a\\\\b", "c\\"d", e\\5c f; background: url(javascript:x); width: expression(alert(1)) }
      p { list-style-type: "url(x)"; behavior: url(x.htc); -moz-binding: url(x); background-color: image(red); color: env(x) }
      p { font-family: "image-set(x)", \\75 rl\\28 x\\29; color: rgb(var(--x)); content: "\\\\" }
      </style><p id=x style="background-image: url(x); background: red url(&quot;\\&quot;)">`;
    const s = one(hostile);
    for (const v of Object.values(s)) {
      expect(v).not.toMatch(/\\|url\(|image\(|image-set\(|expression|env\(|var\(/i);
      // the only functions written are colour functions
      for (const m of v!.matchAll(/([a-z-]+)\(/gi)) expect(['rgb', 'rgba', 'hsl', 'hsla']).toContain(m[1]);
    }
    expect(s.color).toBe('red');
  });
  test('fuzz: random CSS never yields an unsafe value', () => {
    const pieces = ['url(', 'image(', '\\', '"', "'", '(', ')', '{', '}', ';', ':', ',', '/', '!important', 'red', '#fff', '1px', '-2em', '50%', 'rgb(', 'calc(', 'var(', 'color', 'width', 'font-family', 'background', 'margin', 'border', 'font', ' ', '\n', '\\75 rl(', '\\28', 'e\\5c', '@media', 'p', '.a', '*'];
    let seed = 42;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let k = 0; k < 300; k++) {
      let css = '';
      for (let i = 0; i < 40; i++) css += pieces[rand(pieces.length)];
      const s = one(`<style>p{${css}}</style><p id=x class=a style='${css.replace(/'/g, '')}'>`);
      for (const v of Object.values(s)) expect(v).not.toMatch(/\\|url\(|image\(|image-set\(/i);
    }
  });
  test('a hostile 1 MB stylesheet resolves within a second', () => {
    const parts = [
      '('.repeat(100_000),
      '{'.repeat(100_000),
      ':not('.repeat(20_000),
      '@media screen{'.repeat(10_000),
      'a b c d e f g h i j k l m n o p { color: red }'.repeat(2_000),
      '* * * * * * * * * * * * * x { color: red }'.repeat(2_000),
      '"\\'.repeat(50_000),
      'url('.repeat(50_000),
      '*{color:red;margin:0 auto}'.repeat(40_000),
      ':not(#a) * {color:red}'.repeat(40_000),
    ];
    // deep (600 levels) and wide (2,000 elements)
    let deep = '';
    for (let i = 0; i < 200; i++) deep += '<div><span><b>';
    const wide = '<div><p><span>x</span></p></div>'.repeat(660);
    for (const css of parts) {
      for (const body of [deep, wide]) {
        const root = reference(`<style>${css}</style>${body}`);
        const t = performance.now();
        resolveStyles(root, { media: 'wide' });
        expect(performance.now() - t, css.slice(0, 20)).toBeLessThan(1000);
      }
    }
  });
  test('past its matching budget a hostile stylesheet stops matching; a real email is far from it', () => {
    const root = reference(`<style>${'*{color:red}'.repeat(40_000)}</style>` + '<p>x</p>'.repeat(2_000));
    const map = resolveStyles(root, { media: 'wide' });
    const ps = [...map.keys()].filter((e) => e.tag === 'p');
    // the first elements have their style, the last do not
    expect(ps.length).toBeGreaterThan(100);
    expect(ps.length).toBeLessThan(2_000);
    // and matching works again afterwards
    expect(one('<style>p { color: red }</style><p id=x>')).toEqual({ color: 'red' });
  });
  test('past 10,000 rules, the rest of the stylesheet is dropped', () => {
    expect(one(`<style>${'.x{color:red}'.repeat(9_999)}p{color:blue}</style><p id=x>`)).toEqual({ color: 'blue' });
    expect(one(`<style>${'.x{color:red}'.repeat(10_000)}p{color:blue}</style><p id=x>`)).toEqual({});
  });
  test('deep trees and long selector chains stay fast', () => {
    let html = '<style>' + 'div '.repeat(40) + 'span { color: red } ' + 'div ~ '.repeat(30) + 'b { color: blue }</style>';
    html += '<div>'.repeat(250) + '<span id=x></span>' + '</div>'.repeat(250);
    for (let i = 0; i < 300; i++) html += '<div></div>';
    html += '<b></b>';
    const root = reference(html);
    const t = performance.now();
    const map = resolveStyles(root, { media: 'wide' });
    expect(performance.now() - t).toBeLessThan(1000);
    expect([...map.values()].some((s) => s.color === 'red')).toBe(true);
  });
});
