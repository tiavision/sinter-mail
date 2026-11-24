// Writes the bench's emails (bench/corpus/*.html): what bench/html.mjs renders through each path.
//
//   reply.html       a Gmail reply quoting three earlier messages, a signature: the commonest email, small
//   receipt.html     an order confirmation from MJML: a <style> block with classes and @media, Outlook's
//                    conditional comments, a table of line items
//   newsletter.html  a newsletter from MJML: a hero, sixteen two-column sections, buttons, social links
//   outlook.html     a thread of eight messages as Outlook for Windows writes them (Word's HTML): its long
//                    <style> sheet, p.MsoNormal, <o:p>, mso- declarations, a Word table
//   digest.html      a weekly digest of 160 items with every style inline, as an ESP's inliner leaves it
//
// The MJML ones are MJML's own output (what Mailjet and many ESPs send), so the markup is a builder's, not ours:
//   npm install --no-save mjml@4 && node bench/corpus/make.mjs
// The files are committed; this only regenerates them.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'x.js'));
const mjml2html = require('mjml');
const OUT = import.meta.dirname;
const WORDS = 'the quick brown fox jumps over a lazy dog while seven wizards quietly judge boxing matches and pack my box with five dozen liquor jugs before sphinx of black quartz hears our vow'.split(' ');
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const words = (n) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
const sentence = (n) => { const s = words(n); return s[0].toUpperCase() + s.slice(1) + '.'; };
const para = (k) => Array.from({ length: k }, () => sentence(8 + Math.floor(rnd() * 10))).join(' ');
const write = (name, html) => { writeFileSync(join(OUT, name), html); console.log(name.padEnd(16), (html.length / 1024).toFixed(1).padStart(6), 'kB'); };
const mj = (src) => { const r = mjml2html(src, { validationLevel: 'strict' }); if (r.errors.length) throw new Error(JSON.stringify(r.errors)); return r.html; };

// ── reply.html: Gmail ─────────────────────────────────────────────────────────────────────────────────
{
  const who = [['Ada Lovelace', 'ada@example.org'], ['Sam Carter', 'sam@example.com'], ['Ada Lovelace', 'ada@example.org']];
  const quote = (i) => i >= who.length ? '' : `<br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Tue, Nov ${17 - i}, 2026 at ${9 + i}:4${i} AM ${who[i][0]} &lt;<a href="mailto:${who[i][1]}">${who[i][1]}</a>&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr"><div>${para(2)}</div><div><br></div><div>${para(1)} See <a href="https://docs.example.com/plan?rev=${i}&amp;hl=en" target="_blank">the plan</a>.</div><ul><li>${sentence(6)}</li><li><b>${words(3)}</b>: ${sentence(5)}</li></ul><div>Best,</div><div>${who[i][0].split(' ')[0]}</div></div>${quote(i + 1)}</blockquote></div>`;
  write('reply.html', `<div dir="ltr"><div>Hi Ada,</div><div><br></div><div>${para(2)}</div><div><br></div><div>${para(1)} I&#39;ve put the numbers in <a href="https://sheets.example.com/d/1x9?usp=sharing">the sheet</a> &mdash; <i>draft</i>, not final.</div><div><br></div><div>Thanks,</div><div>Sam</div><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr"><div><b>Sam Carter</b></div><div><span style="color:rgb(102,102,102)">Operations, Example Ltd.</span></div><div><a href="tel:+15550100" target="_blank">+1 555 0100</a> · <a href="https://example.com" target="_blank">example.com</a></div></div></div></div>${quote(0)}\n`);
}

// ── receipt.html: MJML ────────────────────────────────────────────────────────────────────────────────
{
  const items = Array.from({ length: 14 }, (_, i) => `<tr><td style="padding: 8px 0; border-bottom: 1px solid #ecedee;"><a href="https://shop.example.com/p/${1000 + i}?ref=receipt" style="color: #1a1a1a; text-decoration: none;">${words(3)}</a><br /><span style="color: #8a8f98; font-size: 12px;">SKU ${4410 + i} &middot; Qty ${1 + (i % 3)}</span></td><td align="right" style="padding: 8px 0; border-bottom: 1px solid #ecedee; white-space: nowrap;">&euro;&nbsp;${(9.5 + i * 3.25).toFixed(2)}</td></tr>`).join('');
  write('receipt.html', mj(`<mjml><mj-head><mj-title>Your order #48213</mj-title><mj-preview>Thanks for your order: it ships tomorrow.</mj-preview>
<mj-attributes><mj-all font-family="Helvetica, Arial, sans-serif" /><mj-text font-size="14px" line-height="21px" color="#1a1a1a" /><mj-section padding="0 24px" /></mj-attributes>
<mj-style inline="inline">.muted div { color: #8a8f98 !important; } .total td { font-weight: bold; font-size: 16px; }</mj-style>
<mj-style>a { color: #2f6fed; } .card { border-radius: 8px; } @media only screen and (max-width: 480px) { .hide-sm { display: none !important; } .card > table { width: 100% !important; } h1 { font-size: 20px !important; } }</mj-style></mj-head>
<mj-body background-color="#f3f4f6" width="600px">
<mj-section padding="24px"><mj-column><mj-image width="132px" height="36px" align="left" src="https://cdn.shop.example.com/logo@2x.png" alt="Shop" href="https://shop.example.com" /></mj-column></mj-section>
<mj-section background-color="#ffffff" css-class="card" padding="24px"><mj-column>
<mj-text font-size="22px" line-height="28px" font-weight="700"><h1 style="margin:0;font-size:22px">Thanks for your order, Sam</h1></mj-text>
<mj-text>${para(2)}</mj-text>
<mj-button background-color="#2f6fed" color="#ffffff" border-radius="6px" href="https://shop.example.com/orders/48213?utm_source=receipt&utm_medium=email" align="left">Track your order</mj-button>
<mj-divider border-width="1px" border-color="#ecedee" />
<mj-table>${`<tr style="text-align:left;"><th style="padding: 0 0 8px;">Item</th><th align="right" style="padding: 0 0 8px;">Price</th></tr>`}${items}<tr class="total"><td style="padding: 12px 0 0;">Total</td><td align="right" style="padding: 12px 0 0;">&euro;&nbsp;428.75</td></tr></mj-table>
</mj-column></mj-section>
<mj-section background-color="#ffffff" padding="0 24px 24px"><mj-column><mj-text font-weight="700">Shipping to</mj-text><mj-text css-class="muted">Sam Carter<br />12 Canal Street<br />1011 AB Amsterdam</mj-text></mj-column><mj-column><mj-text font-weight="700">Payment</mj-text><mj-text css-class="muted">Visa &bull;&bull;&bull;&bull; 4242<br />Billed on 24 Nov 2026</mj-text></mj-column></mj-section>
<mj-section padding="24px"><mj-column><mj-text css-class="muted" font-size="12px" line-height="18px" align="center">${sentence(14)} <a href="https://shop.example.com/help">Help centre</a> &middot; <a href="https://shop.example.com/returns">Returns</a><br /><span class="hide-sm">Shop B.V., Keizersgracht 1, Amsterdam</span></mj-text></mj-column></mj-section>
</mj-body></mjml>`));
}

// ── newsletter.html: MJML ─────────────────────────────────────────────────────────────────────────────
{
  const article = (i) => `<mj-column padding="8px"><mj-image src="https://img.news.example.com/2026/11/story-${i}.jpg" alt="${words(3)}" width="268px" height="150px" border-radius="6px" href="https://news.example.com/story/${i}?utm_campaign=weekly-47" />
<mj-text css-class="kicker" font-size="11px" letter-spacing="1px" text-transform="uppercase" color="#b0413e" padding-bottom="0">${words(2)}</mj-text>
<mj-text font-size="18px" line-height="24px" font-weight="700" padding-bottom="0"><a class="title" href="https://news.example.com/story/${i}?utm_campaign=weekly-47">${sentence(6)}</a></mj-text>
<mj-text>${para(2)} <em>${words(4)}</em> &amp; <strong>${words(2)}</strong>.</mj-text>
<mj-button css-class="more" background-color="#ffffff" color="#1f2937" border="1px solid #d1d5db" border-radius="4px" font-size="13px" inner-padding="8px 14px" align="left" href="https://news.example.com/story/${i}?utm_campaign=weekly-47#more">Read more &rarr;</mj-button></mj-column>`;
  const sections = Array.from({ length: 16 }, (_, s) => `<mj-section background-color="#ffffff" padding="8px 16px">${article(s * 2)}${article(s * 2 + 1)}</mj-section>${s % 4 === 3 ? `<mj-section background-color="#ffffff" padding="0 24px"><mj-column><mj-divider border-width="1px" border-color="#e5e7eb" /><mj-text align="center" font-size="13px" color="#6b7280">Sponsored &middot; <a href="https://ads.example.net/c/${s}">${sentence(7)}</a></mj-text><mj-divider border-width="1px" border-color="#e5e7eb" /></mj-column></mj-section>` : ''}`).join('\n');
  write('newsletter.html', mj(`<mjml><mj-head><mj-title>The Weekly, no. 47</mj-title><mj-preview>${sentence(12)}</mj-preview>
<mj-attributes><mj-all font-family="Georgia, 'Times New Roman', serif" /><mj-text font-size="15px" line-height="23px" color="#1f2937" padding="8px 0" /><mj-image padding="0 0 8px" /><mj-button font-family="Helvetica, Arial, sans-serif" /></mj-attributes>
<mj-style>a { color: #b0413e; } a.title { color: #111827; text-decoration: none; } .kicker div { font-family: Helvetica, Arial, sans-serif !important; } .footer a { color: #6b7280 !important; text-decoration: underline; }
.dark-only { display: none; }
@media only screen and (max-width: 480px) { .more a { display: block !important; } .hero img { height: auto !important; } .desktop { display: none !important; } }
@media (prefers-color-scheme: dark) { .wrap { background-color: #111827 !important; } .footer div { color: #9ca3af !important; } }</mj-style></mj-head>
<mj-body background-color="#f3f1ec" width="600px" css-class="wrap">
<mj-section padding="20px 24px 8px"><mj-column width="60%"><mj-image width="160px" height="40px" align="left" src="https://img.news.example.com/masthead.png" alt="The Weekly" /></mj-column><mj-column width="40%"><mj-text align="right" font-size="12px" color="#6b7280" css-class="desktop">24 November 2026 &middot; <a href="https://news.example.com/w/47">View online</a></mj-text></mj-column></mj-section>
<mj-section background-color="#ffffff" padding="0"><mj-column><mj-image css-class="hero" padding="0" src="https://img.news.example.com/2026/11/hero.jpg" alt="${words(4)}" width="600px" height="300px" href="https://news.example.com/story/lead" />
<mj-text padding="20px 24px 0" font-size="28px" line-height="34px" font-weight="700">${sentence(7)}</mj-text><mj-text padding="12px 24px 20px" font-size="17px" line-height="26px">${para(3)}</mj-text></mj-column></mj-section>
${sections}
<mj-section padding="24px"><mj-column><mj-social font-size="12px" icon-size="24px" mode="horizontal"><mj-social-element name="facebook" href="https://social.example/fb">&nbsp;</mj-social-element><mj-social-element name="twitter" href="https://social.example/x">&nbsp;</mj-social-element><mj-social-element name="instagram" href="https://social.example/ig">&nbsp;</mj-social-element><mj-social-element name="linkedin" href="https://social.example/in">&nbsp;</mj-social-element></mj-social>
<mj-text css-class="footer" align="center" font-size="12px" line-height="18px" color="#6b7280">You get The Weekly because you signed up at news.example.com.<br /><a href="https://news.example.com/unsubscribe?u=8271&t=ab12">Unsubscribe</a> &middot; <a href="https://news.example.com/preferences?u=8271">Preferences</a> &middot; <a href="https://news.example.com/privacy">Privacy</a><br />The Weekly Media GmbH, Lindenstra&szlig;e 9, 10969 Berlin</mj-text></mj-column></mj-section>
<mj-raw><img src="https://track.news.example.com/o/8271/47.gif" width="1" height="1" alt="" style="display:block" /></mj-raw>
</mj-body></mjml>`));
}

// ── outlook.html: Word's HTML, a thread ───────────────────────────────────────────────────────────────
{
  const style = `<!--
/* Font Definitions */
@font-face {font-family:"Cambria Math"; panose-1:2 4 5 3 5 4 6 3 2 4;}
@font-face {font-family:Calibri; panose-1:2 15 5 2 2 2 4 3 2 4;}
@font-face {font-family:Aptos; panose-1:2 11 0 4 2 2 2 2 2 4;}
@font-face {font-family:"Segoe UI"; panose-1:2 11 5 2 4 2 4 2 2 3;}
/* Style Definitions */
p.MsoNormal, li.MsoNormal, div.MsoNormal {margin:0cm; font-size:11.0pt; font-family:"Calibri",sans-serif; mso-ligatures:standardcontextual; mso-fareast-language:EN-US;}
h1 {mso-style-priority:9; mso-style-link:"Heading 1 Char"; margin-top:12.0pt; margin-right:0cm; margin-bottom:0cm; margin-left:0cm; page-break-after:avoid; font-size:16.0pt; font-family:"Calibri Light",sans-serif; color:#2F5496; font-weight:normal;}
a:link, span.MsoHyperlink {mso-style-priority:99; color:#0563C1; text-decoration:underline;}
a:visited, span.MsoHyperlinkFollowed {mso-style-priority:99; color:#954F72; text-decoration:underline;}
p.MsoListParagraph, li.MsoListParagraph, div.MsoListParagraph {mso-style-priority:34; margin-top:0cm; margin-right:0cm; margin-bottom:0cm; margin-left:36.0pt; font-size:11.0pt; font-family:"Calibri",sans-serif; mso-fareast-language:EN-US;}
p.MsoPlainText, li.MsoPlainText, div.MsoPlainText {mso-style-priority:99; mso-style-link:"Plain Text Char"; margin:0cm; font-size:11.0pt; font-family:"Calibri",sans-serif;}
p.xmsonormal, li.xmsonormal, div.xmsonormal {mso-style-name:x_msonormal; margin:0cm; font-size:11.0pt; font-family:"Calibri",sans-serif;}
span.EmailStyle18 {mso-style-type:personal; font-family:"Calibri",sans-serif; color:windowtext;}
span.EmailStyle21 {mso-style-type:personal-reply; font-family:"Aptos",sans-serif; color:#1F497D;}
span.PlainTextChar {mso-style-name:"Plain Text Char"; mso-style-priority:99; mso-style-link:"Plain Text"; font-family:"Calibri",sans-serif;}
table.MsoTableGrid {mso-style-name:"Table Grid"; border:solid windowtext 1.0pt; border-collapse:collapse;}
.MsoChpDefault {mso-style-type:export-only; font-size:10.0pt; mso-ligatures:none;}
@page WordSection1 {size:612.0pt 792.0pt; margin:70.85pt 70.85pt 2.0cm 70.85pt;}
div.WordSection1 {page:WordSection1;}
/* List Definitions */
@list l0 {mso-list-id:1234567890; mso-list-type:hybrid; mso-list-template-ids:-1 67698703 67698713;}
@list l0:level1 {mso-level-tab-stop:none; mso-level-number-position:left; text-indent:-18.0pt;}
ol {margin-bottom:0cm;}
ul {margin-bottom:0cm;}
-->`;
  const p = (t, color = '') => `<p class="MsoNormal"><span style="${color ? `color:${color};` : ''}mso-fareast-language:EN-US">${t}<o:p></o:p></span></p>`;
  const empty = '<p class="MsoNormal"><span style="mso-fareast-language:EN-US"><o:p>&nbsp;</o:p></span></p>';
  const people = [['Carter, Sam', 'sam.carter@example.com'], ['Lovelace, Ada', 'ada.lovelace@example.org'], ['Okafor, Chidi', 'chidi.okafor@example.com']];
  const table = (k) => `<table class="MsoTableGrid" border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:none"><tbody>${Array.from({ length: 6 }, (_, r) => `<tr>${Array.from({ length: 4 }, (_, c) => `<td width="151" valign="top" style="width:113.3pt;border:solid windowtext 1.0pt;${r ? 'border-top:none;' : ''}${c ? 'border-left:none;' : ''}padding:0cm 5.4pt 0cm 5.4pt">${r === 0 ? `<p class="MsoNormal"><b><span style="mso-fareast-language:EN-US">${words(1)}<o:p></o:p></span></b></p>` : p(c ? String(Math.round(rnd() * 900 + k)) : words(2))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const message = (i) => `${p(`Hi ${people[(i + 1) % 3][0].split(', ')[1]},`, i % 2 ? '#1F497D' : '')}${empty}${p(para(2), i % 2 ? '#1F497D' : '')}${empty}${i % 3 === 0 ? table(i) + empty : ''}${i % 2 ? `<p class="MsoListParagraph" style="text-indent:-18.0pt;mso-list:l0 level1 lfo1"><![if !supportLists]><span style="mso-list:Ignore">1.<span style="font:7.0pt &quot;Times New Roman&quot;">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span><![endif]><span style="mso-fareast-language:EN-US">${sentence(9)}<o:p></o:p></span></p><p class="MsoListParagraph" style="text-indent:-18.0pt;mso-list:l0 level1 lfo1"><![if !supportLists]><span style="mso-list:Ignore">2.<span style="font:7.0pt &quot;Times New Roman&quot;">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span><![endif]><span style="mso-fareast-language:EN-US">${sentence(7)} <a href="https://intranet.example.com/sites/ops/Shared%20Documents/plan-${i}.docx">plan-${i}.docx</a><o:p></o:p></span></p>${empty}` : ''}${p(para(1), i % 2 ? '#1F497D' : '')}${empty}${p('Kind regards,')}${p(people[i % 3][0].split(', ')[1])}${empty}<p class="MsoNormal"><b><span style="font-size:10.0pt;font-family:&quot;Segoe UI&quot;,sans-serif;color:#2F5496">${people[i % 3][0]}</span></b><span style="font-size:10.0pt;font-family:&quot;Segoe UI&quot;,sans-serif;color:gray"> | Operations<br>Example Ltd. | <a href="https://www.example.com/"><span style="color:#0563C1">www.example.com</span></a><o:p></o:p></span></p>${empty}`;
  const header = (i) => `<div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal"><b><span lang="EN-US">From:</span></b><span lang="EN-US"> ${people[i % 3][0]} &lt;${people[i % 3][1]}&gt; <br><b>Sent:</b> Monday, ${23 - i} November 2026 1${i}:0${i}<br><b>To:</b> ${people[(i + 1) % 3][0]} &lt;${people[(i + 1) % 3][1]}&gt;<br><b>Cc:</b> ${people[(i + 2) % 3][0]} &lt;${people[(i + 2) % 3][1]}&gt;<br><b>Subject:</b> RE: Q4 planning &amp; budget<o:p></o:p></span></p></div></div>${empty}`;
  write('outlook.html', `<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns:m="http://schemas.microsoft.com/office/2004/12/omml" xmlns="http://www.w3.org/TR/REC-html40"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="Generator" content="Microsoft Word 15 (filtered medium)"><style>${style}</style><!--[if gte mso 9]><xml>
<o:shapedefaults v:ext="edit" spidmax="1026" />
</xml><![endif]--><!--[if gte mso 9]><xml>
<o:shapelayout v:ext="edit">
<o:idmap v:ext="edit" data="1" />
</o:shapelayout></xml><![endif]--></head><body lang="EN-GB" link="#0563C1" vlink="#954F72" style="word-wrap:break-word"><div class="WordSection1">${Array.from({ length: 8 }, (_, i) => (i ? header(i) : '') + message(i)).join('')}</div></body></html>\n`);
}

// ── digest.html: everything inline ────────────────────────────────────────────────────────────────────
{
  const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const LABELS = [['bug', '#d73a4a', '#ffffff'], ['enhancement', '#a2eeef', '#24292f'], ['docs', '#0075ca', '#ffffff'], ['question', '#d876e3', '#24292f']];
  const item = (i) => { const l = LABELS[i % 4]; return `<tr><td style="padding:12px 16px;border-bottom:1px solid #d0d7de;${FONT};font-size:14px;line-height:20px;color:#24292f" valign="top"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td width="28" valign="top" style="width:28px;padding:2px 8px 0 0"><img src="https://avatars.example.dev/u/${300 + (i % 23)}?s=40" width="20" height="20" alt="" style="display:block;border-radius:10px;border:0"></td><td valign="top" style="${FONT};font-size:14px;line-height:20px;color:#24292f"><a href="https://code.example.dev/acme/app/issues/${4100 + i}?email_source=digest&amp;email_token=AB${i}CD" style="color:#0969da;text-decoration:none;font-weight:600">${sentence(7)}</a> <span style="display:inline-block;padding:0 7px;font-size:12px;font-weight:500;line-height:18px;border-radius:24px;background-color:${l[1]};color:${l[2]}">${l[0]}</span><br><span style="font-size:12px;line-height:18px;color:#57606a">#${4100 + i} opened by <a href="https://code.example.dev/u${i % 23}" style="color:#57606a;text-decoration:underline">u${i % 23}</a> &middot; ${1 + (i % 9)} comments &middot; updated ${1 + (i % 6)}&nbsp;days ago</span><p style="margin:6px 0 0;${FONT};font-size:13px;line-height:19px;color:#57606a">${para(1)}</p></td><td width="60" align="right" valign="top" style="width:60px;${FONT};font-size:12px;line-height:20px;color:#57606a;white-space:nowrap">+${i * 7 % 90}&nbsp;<span style="color:#cf222e">&minus;${i * 3 % 40}</span></td></tr></table></td></tr>`; };
  write('digest.html', `<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"><title>Your weekly digest</title></head><body style="margin:0;padding:0;background-color:#f6f8fa;${FONT}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f8fa"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="720" cellpadding="0" cellspacing="0" border="0" style="width:720px;max-width:100%;background-color:#ffffff;border:1px solid #d0d7de;border-radius:6px"><tr><td style="padding:20px 16px;border-bottom:1px solid #d0d7de;${FONT}"><h1 style="margin:0;font-size:20px;line-height:28px;font-weight:600;color:#24292f">acme/app: 160 updates this week</h1><p style="margin:4px 0 0;font-size:14px;line-height:20px;color:#57606a">${sentence(12)}</p></td></tr>${Array.from({ length: 160 }, (_, i) => item(i)).join('')}<tr><td align="center" style="padding:16px;${FONT};font-size:12px;line-height:18px;color:#57606a">You are receiving this because you watch acme/app.<br><a href="https://code.example.dev/settings/notifications" style="color:#0969da;text-decoration:underline">Manage notifications</a> &middot; <a href="https://code.example.dev/acme/app/unsubscribe?t=xyz" style="color:#0969da;text-decoration:underline">Unsubscribe</a></td></tr></table></td></tr></table><img src="https://code.example.dev/notifications/beacon/AB12.gif" height="1" width="1" alt="" style="display:block;overflow:hidden"></body></html>\n`);
}
