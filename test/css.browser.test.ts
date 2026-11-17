// Fidelity against Chromium: each document is rendered as written in one page, and in another with every
// <style>, every presentational attribute and every style attribute removed and the resolved styles set
// with style.setProperty, as <mail-body>'s components set them. Every kept property's computed value
// must then agree on every element, but for the differences listed in ACCEPTED, each with its reason.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { resolveStyles } from '../sinter/css/index.js';
import { PROPERTIES } from '../sinter/tags.js';
import type { RawElement } from '../sinter/raw.js';
import type { Style } from '../sinter/sinter.types.js';
import { reference } from './reference.js';

const VIEWPORTS = { wide: { width: 800, height: 600 }, narrow: { width: 375, height: 667 } } as const;

// the attributes the cascade reads, removed in the second page (the components never write them)
const PRESENTATIONAL = [
  'style', 'bgcolor', 'width', 'height', 'align', 'valign', 'border', 'bordercolor', 'cellpadding', 'cellspacing', 'color',
  'face', 'size', 'text', 'link', 'vlink', 'alink', 'nowrap', 'noshade', 'hspace', 'vspace', 'clear', 'marginwidth',
  'marginheight', 'leftmargin', 'rightmargin', 'topmargin', 'bottommargin',
];

/**
 * Differences accepted, each with why. `match` is tested against `<doc> <tag>#<index> <property>`.
 */
const ACCEPTED: { match: RegExp; why: string }[] = [
  {
    match: /^legacy img#\d+ vertical-align$/,
    why: "img align=middle is Chromium's -webkit-baseline-middle; the cascade writes `middle`, which every engine has",
  },
  {
    match: /^values div#\d+ overflow$/,
    why: '`overflow: clip` is written as `hidden` (same painting, no scroll container either way for an email)',
  },
  {
    match: /^values (p#16 (margin-left|margin-top|width)|(html|body)#\d+ height)$/,
    why: 'negative margins are written as 0: an email must not reach outside its box (the width, and the height of the document, follow the margin)',
  },
  {
    match: /^values p#\d+ text-indent$/,
    why: 'negative text-indent is written as 0 (the -9999px trick moves text over the app)',
  },
];

const DOCS: Record<string, string> = {
  outlook: `<!doctype html><html xmlns:o="urn:schemas-microsoft-com:office:office"><head>
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  p.MsoNormal, li.MsoNormal, div.MsoNormal { margin: 0cm; margin-bottom: .0001pt; font-size: 11.0pt; font-family: "Calibri", sans-serif; mso-fareast-language: EN-US }
  a:link, span.MsoHyperlink { mso-style-priority: 99; color: #0563C1; text-decoration: underline }
  span.EmailStyle17 { mso-style-type: personal-compose; font-family: "Calibri",sans-serif; color: windowtext }
  .MsoChpDefault { mso-style-type: export-only; font-family: "Calibri",sans-serif }
  @page WordSection1 { size: 612.0pt 792.0pt; margin: 72.0pt 72.0pt 72.0pt 72.0pt }
  div.WordSection1 { page: WordSection1 }
  .hack { *zoom: 1; _height: 1px; color: red !ie; width: 100px\9; color: blue }
  @font-face { font-family: "Cambria Math"; src: local(x) }
  @supports (display: grid) { .hack { color: red } }
  @import url(x.css);
</style></head>
<body lang="EN-US" link="#0563C1" vlink="#954F72" style="tab-interval:36.0pt">
<div class="WordSection1"><p class="MsoNormal">Hi there,<o:p></o:p></p><p class="MsoNormal"><o:p>&nbsp;</o:p></p>
<p class="MsoNormal">See <a href="https://example.com"><span style="color:#0563C1">the doc</span></a>.<o:p></o:p></p>
<p class="MsoNormal"><span class="EmailStyle17" style="font-size:10.0pt;mso-bidi-font-family:Arial">Regards</span></p>
<div class="hack">hack</div>
<table class="MsoNormalTable" border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;mso-yfti-tbllook:1184">
<tr><td width="200" valign="top" style="width:150.0pt;border:solid windowtext 1.0pt;padding:0cm 5.4pt 0cm 5.4pt"><p class="MsoNormal">A</p></td>
<td valign="top" style="border:solid windowtext 1.0pt;border-left:none;padding:0cm 5.4pt 0cm 5.4pt"><p class="MsoNormal" align="center" style="text-align:center">B</p></td></tr></table>
</div></body></html>`,

  cascade: `<!doctype html><html><head><style>
  td { padding: 0 } table.s { border-spacing: 6px } .t td { vertical-align: bottom }
  .inh { color: inherit; font-size: initial; line-height: unset } .wrap { color: #c00; line-height: 3 }
  .reset { font: 12px serif } .link a { text-decoration: inherit; color: inherit } .link { text-decoration: underline; color: #090 }
  @media screen and (max-width: 600px) { .m { font-size: 20px !important; color: red } .m2 { display: none } }
  @media (min-width: 601px) { .m { color: blue !important } }
  .m { font-size: 10px; color: green } #one.m { color: black }
  [ALIGN=CENTER] { font-weight: bold } td[valign="TOP" s] { color: red } td[valign="TOP" i] { font-style: italic }
  .imp { color: red !important } .imp2 { color: green }
</style></head><body>
<table cellpadding="10" class="s" cellspacing="1"><tr><td>pad</td><td align=center valign=top>c</td></tr></table>
<table class="t"><tr valign="top"><td>x</td><td valign="middle">y</td></tr></table>
<div class="wrap"><span class="inh">inh</span><div class="reset">reset</div></div>
<p class="link"><a href="#">a</a></p>
<p id="one" class="m">m1</p><p class="m">m2</p><p class="m2">m3</p>
<p class="imp imp2" style="color: blue">imp</p><p class="imp2" style="color: blue !important">imp2</p>
</body></html>`,
  newsletter: `<!doctype html><html><head><meta charset="utf-8"><title>News</title>
<style type="text/css">
  body { margin: 0; padding: 0; font-family: Helvetica, Arial, sans-serif; }
  .wrapper { background-color: #f4f4f4; }
  #main { border: 1px solid #dddddd; }
  .header td { padding: 20px 30px; font-size: 24px; color: #ffffff; }
  .content p { margin: 0 0 12px; line-height: 1.5; }
  .content p + p { color: #555555; }
  .content h2 ~ p { font-style: italic; }
  td.button a { display: inline-block; padding: 10px 18px; background: #e94e1b; color: #fff !important; text-decoration: none; border-radius: 4px; }
  a { color: #e94e1b; }
  .footer, .footer a { font-size: 11px; color: #999999; }
  @media only screen and (max-width: 600px) {
    #main { width: 100% !important; }
    .content td { padding: 10px !important; }
    .hide-mobile { display: none !important; }
  }
  @media print { body { color: red } }
</style></head>
<body bgcolor="#f4f4f4" style="-webkit-text-size-adjust:none; margin:0">
<table class="wrapper" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#f4f4f4"><tr><td align="center" valign="top">
  <table id="main" width="600" border="0" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:600px">
    <tr class="header"><td bgcolor="#333333" align="left"><font face="Georgia, serif">The Weekly</font></td></tr>
    <tr><td class="content" style="padding: 30px; font-size: 15px; color:#333">
      <h2 style="margin:0 0 10px; font: bold 20px/1.2 Georgia, serif">Hello</h2>
      <p>First paragraph with <a href="https://example.com">a link</a> and <b>bold</b>.</p>
      <p>Second paragraph.</p>
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td class="button" align="center"><a href="https://example.com/go">Read more</a></td>
        <td class="hide-mobile" width="200" valign="middle"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="200" height="100" border="0" alt="" style="display:block"></td>
      </tr></table>
    </td></tr>
    <tr><td class="footer" align="center" style="padding:20px">You are subscribed. <a href="#">Unsubscribe</a></td></tr>
  </table>
</td></tr></table>
</body></html>`,

  receipt: `<!doctype html><html><head><style>
  h1, h2 { margin: 0; font-weight: normal }
  h1 { font-size: 28px; letter-spacing: -0.5px }
  table.items { border-collapse: collapse; width: 100%; table-layout: fixed }
  .items th { text-align: left; border-bottom: 2px solid #000; padding: 4px 8px; text-transform: uppercase; font-size: 11px }
  .items td { padding: 4px 8px; border-bottom: 1px solid #eee; }
  .items tr:nth-child(even) td { background-color: rgba(0, 0, 0, 0.04) }
  .items tr:last-child td { border-bottom: none; font-weight: 700 }
  .items td + td { text-align: right; white-space: nowrap }
  td[align="right"] { color: hsl(210, 50%, 40%) }
  p:not(.note) { margin: 8px 0 }
  .note { font-size: smaller; color: #777; margin: 16px 0 0 }
  .total { font: italic small-caps 600 16px/20px "Courier New", monospace }
  ul.list { list-style: square inside; padding-left: 0 }
  ul.list li:first-child { color: green } ul.list li:only-child { color: red }
</style></head><body style="font-family: Arial; font-size: 14px">
<h1>Receipt</h1><h2 style="color: #666">Order 1234</h2>
<p>Thanks for your order.</p><p class="note">Keep this for your records.</p>
<table class="items"><thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead>
<tbody><tr><td>Widget</td><td>2</td><td align="right">$10.00</td></tr><tr><td>Gadget with a long name that wraps</td><td>1</td><td align="right">$5.00</td></tr>
<tr><td>Total</td><td></td><td class="total" align="right">$25.00</td></tr></tbody></table>
<ul class="list"><li>One</li><li>Two</li></ul><ul class="list"><li>Only</li></ul>
<p style="border: 1px dashed; border-color: #ccc #999; padding: 4px 8px 12px; margin: 0 auto; width: 50%; text-align: center">Centered box</p>
<div style="background: #fafafa url(x.png) no-repeat; border-top: 3px double red; text-decoration: underline wavy blue">Decorated</div>
</body></html>`,

  legacy: `<!doctype html><html><body bgcolor="ffffcc" text="#333366" link="#cc0000" marginwidth="0" marginheight="0" leftmargin="0" topmargin="0">
<center><font face="Verdana, Arial" size="2" color="navy">Centered legacy text <font size="+2">bigger</font> <font size="-1">smaller</font> <font size=7>huge</font></font></center>
<div align="right">Right <a href="#">link</a></div><p align="justify">Justified paragraph.</p><h3 align="center">Heading</h3>
<table border="1" cellpadding="5" cellspacing="2" bordercolor="#999999" align="center" width="80%">
  <caption align="bottom">Caption</caption>
  <tr bgcolor="#eeeeee" align="center" valign="bottom"><th>A</th><th nowrap>B is a header</th></tr>
  <tr><td valign="top" height="40" width="30%">top</td><td bgcolor="lightblue">cell</td></tr>
</table>
<table border="3" cellpadding="junk"><tr><td>bordered</td></tr></table>
<table border="0" cellspacing="0" cellpadding="0" align="left"><tr><td bgcolor="#ccc" width="100">float</td></tr></table>
<br clear="all">
<hr noshade size="3" width="50%"><hr color="red" size="1" align="left" width="200">
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40" hspace="10" vspace="5" border="2" align="middle" alt="">
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40" align="right" alt="">
<table width="100%"><tbody valign="top" align="right"><tr><td>section aligned</td><td valign="bottom" align="left">own</td></tr></tbody></table>
</body></html>`,

  selectors: `<!doctype html><html><head><style>
  :root { color: #222 }
  div > p:first-child { color: blue } div > p:last-of-type { font-weight: bold } span:empty { padding: 2px; border: 1px solid }
  ul li:nth-child(2n+1) { background-color: #eee } ul li:nth-last-child(1) { color: purple } li:nth-of-type(2) { font-style: italic }
  :is(h1, h2).title { text-decoration: underline } :where(.box) p { margin: 0 } .box p { margin: 4px }
  a:link { color: green } a:visited { color: red } a:hover { color: orange } p::before { content: "x"; color: red }
  [data-kind~="promo"] { border-left: 4px solid gold } [lang|=en] { font-family: Georgia } a[href^="mailto:"] { font-weight: bold }
  #a.b.c { color: maroon } .c.b#a { width: 50px } * + h2 { margin-top: 30px }
  p:not(.x):not(.y) { line-height: 2 } .x ~ .y { color: teal } .weird, p:frobnicate { color: red }
  .ok, .ok::selection { color: olive } tr > td:only-child { vertical-align: top } table td:first-child:last-child { height: 30px }
  #sec > *:nth-child(odd of .k) { color: navy }
</style></head><body>
<div class="box"><p>first</p><p class="x">x</p><p class="y">y</p><span></span><span> </span></div>
<ul><li>1</li><li>2</li><li>3</li><li>4</li></ul>
<h1 class="title">T1</h1><h2 class="title">T2</h2><h3 class="title">T3</h3>
<p><a href="https://example.com">link</a> <a>not a link</a> <a href="mailto:a@b">mail</a></p>
<div data-kind="news promo">promo</div><p lang="en-GB">english</p><p id="a" class="b c">abc</p><p class="weird">w</p><p class="ok">ok</p>
<table><tr><td>only</td></tr><tr><td>a</td><td>b</td></tr></table>
<section id="sec"><i class="k">1</i><i>2</i><i class="k">3</i><i class="k">4</i></section>
</body></html>`,

  values: `<!doctype html><html><head><style>
  .a { color: hsl(120deg 60% 40% / 0.8); background-color: rgb(10 20 30 / 10%); opacity: .75; border-radius: 10px 5px / 20px }
  .b { display: inline-block; width: 10em; min-width: 50px; max-width: 80%; height: auto; box-sizing: border-box; padding: 1em 2rem }
  .c { overflow: clip; float: right; clear: both } .d { white-space: pre-wrap; word-break: break-all; overflow-wrap: anywhere }
  .e { vertical-align: -2px; text-transform: capitalize; font-variant: small-caps; word-spacing: 4px; text-indent: 2em }
  .f { list-style-type: lower-roman; list-style-position: inside } .g { border-spacing: 4px 8px; caption-side: bottom; border-collapse: separate }
  .h { margin: -10px 0 0 -20px } .i { text-indent: -9999px } .j { font-size: 1.25em; line-height: 150% } .k { font-weight: bolder; font-size: larger }
  .l { border-width: thin medium thick 2pt; border-style: solid dotted dashed double; border-color: red green blue currentcolor }
  .m { display: flex } .n { display: grid } .o { display: table; } .p { color: transparent; background-color: currentColor }
  .q { font-family: "\\5FAE\\8F6F\\96C5\\9ED1", 'Segoe UI', Roboto, "Helvetica Neue", sans-serif }
  .r { word-wrap: break-word; text-decoration-line: line-through; text-decoration-style: double }
  .s { margin: 1in 2cm 3mm 4pc; padding: 1pt 2q 3ex 4ch }
</style></head><body>
<div class="a">a</div><div class="b">b</div><div class="c">c</div><div class="d">d d d</div><p class="e">e</p>
<ol class="f"><li>f</li></ol><table class="g"><caption>cap</caption><tr><td>g</td></tr></table>
<p class="h">h</p><p class="i">i</p><div class="j">j<span class="k">k</span></div><div class="l">l</div>
<div class="m"><span>m</span></div><div class="n"><span>n</span></div><div class="o">o</div><div class="p">p</div>
<div class="q">q</div><div class="r">r</div><div class="s">s</div>
<div style="color: RED; COLOR: blue !important; color: green">imp</div><div style="font: 12px/2 serif; font-weight: bold">font</div>
<span style="display:block; margin: 0 auto; width: 100px; border: 2px solid #abcdef">blk</span>
</body></html>`,
};

/** the resolved styles of a document, in document order of its HTML elements */
function resolvedInOrder(html: string, media: 'wide' | 'narrow'): (Style | null)[] {
  const root = reference(html);
  const map = resolveStyles(root, { media });
  const out: (Style | null)[] = [];
  const stack: RawElement[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    out.push(map.get(el) ?? null);
    for (let i = el.children.length - 1; i >= 0; i--) {
      const c = el.children[i];
      if (c.type === 'element') stack.push(c);
    }
  }
  return out;
}

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

interface Result {
  tags: string[];
  values: (string[] | null)[];
}

async function computed(html: string, media: 'wide' | 'narrow', styles: (Style | null)[] | null): Promise<Result & { rejected: string[] }> {
  const page = await browser.newPage({ viewport: VIEWPORTS[media] });
  try {
    await page.setContent(html);
    return await page.evaluate(
      ({ styles, props, attrs }) => {
        const els = [...document.getElementsByTagName('*')].filter((e) => e.namespaceURI === 'http://www.w3.org/1999/xhtml') as HTMLElement[];
        const rejected: string[] = [];
        if (styles) {
          if (els.length !== styles.length) throw new Error(`element count: ${els.length} in the page, ${styles.length} resolved`);
          for (const s of [...document.querySelectorAll('style')]) s.remove();
          els.forEach((e, i) => {
            for (const a of attrs) e.removeAttribute(a);
            const st = styles[i];
            if (!st) return;
            for (const [k, v] of Object.entries(st)) {
              e.style.setProperty(k, v as string);
              if (e.style.getPropertyValue(k) === '') rejected.push(`${e.localName}#${i} ${k}: ${v}`);
            }
          });
        }
        const tags = els.map((e) => e.localName);
        const values = els.map((e) => {
          if (e.localName === 'style' || !e.isConnected) return null;
          const cs = getComputedStyle(e);
          return props.map((p) => cs.getPropertyValue(p));
        });
        return { tags, values, rejected };
      },
      { styles, props: [...PROPERTIES], attrs: PRESENTATIONAL },
    );
  } finally {
    await page.close();
  }
}

// the accepted differences seen, so that the list cannot keep an entry that no longer applies
const used = new Set<string>();

describe('fidelity against Chromium', () => {
  for (const [name, html] of Object.entries(DOCS)) {
    for (const media of ['wide', 'narrow'] as const) {
      test(`${name} (${media})`, async () => {
        const styles = resolvedInOrder(html, media);
        const original = await computed(html, media, null);
        const rendered = await computed(html, media, styles);
        // every value written is one Chromium accepts
        expect(rendered.rejected).toEqual([]);
        const differences: string[] = [];
        original.tags.forEach((tag, i) => {
          const a = original.values[i];
          const b = rendered.values[i];
          if (!a || !b) return;
          PROPERTIES.forEach((p, k) => {
            if (a[k] === b[k]) return;
            const key = `${name} ${tag}#${i} ${p}`;
            const ok = ACCEPTED.find((x) => x.match.test(key));
            if (ok) used.add(ok.why);
            else differences.push(`${key}: ${a[k]} | ${b[k]}`);
          });
        });
        expect(differences).toEqual([]);
      });
    }
  }
  test('every accepted difference is still one', () => {
    expect(ACCEPTED.map((a) => a.why).filter((w) => !used.has(w))).toEqual([]);
  });
});
