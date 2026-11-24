# Email

`@tiavision/sinter-mail` shows the body of an email in a sinter app, without an iframe. `mail.parse`
turns an email's HTML into a tree, `mail.plain` does the same for a plain-text email, and `<mail-body>`
renders the tree as part of the page: it scrolls, selects, searches and prints with it, and takes the
page's fonts where the email sets none.

```html
<sn-resource name="msg" src="/api/messages/{$url.id}"></sn-resource>
<article data-sn-let="{ body: msg.html ? mail.parse(msg.html, { images: 'proxy', proxy: '/img?url={url}' }) : mail.plain(msg.text) }">
  <mail-body data-sn-with="{ body }"></mail-body>
</article>
```

Nothing an email contains runs, loads from the network without the app's consent, or reaches outside
its box. The rest of this page says what is kept, how it looks, and what the app decides.

## Setup

```sh
npm install @tiavision/sinter-mail
```

```js
// vite.config.js
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

export default defineConfig({
  plugins: [sinter({ libraries: ['@tiavision/sinter-mail'] })],
});
```

```ts
// src/sinter.helpers.ts: the helpers, as the namespace `mail`
export * as mail from '@tiavision/sinter-mail';

// src/sinter.types.ts: the tree's types, for your own declarations
export type { Body, Element } from '@tiavision/sinter-mail';
```

sinter-mail needs sinter 0.22.0 or later (until it is released, sinter's main).

## Three places, one function

`mail.parse(html, options)` is a pure function, so sinter runs it wherever its argument is:

| The email | Where it is parsed | What the page ships |
| --- | --- | --- |
| A file: `src="file:./welcome.html"` | at build time | the email as plain HTML, no JavaScript |
| HTML from an API, in a `data-sn-let` | in the browser, once per source and options | the parser, about 40 kB gzip, and the components, about 16 kB |
| The same, with the package lazy | in the browser, once the parser has loaded | the parser in a chunk of its own |
| A tree from your API (`mail.parse` run on the server, in Node) | on the server | no parser: the components only |

To make the parser lazy, list the package in `lazy`; a let that calls `mail.parse` is `undefined` until the
parser has arrived, and `<mail-body>` with no body renders an empty `<div class="mail">`:

```js
sinter({ libraries: ['@tiavision/sinter-mail'], lazy: ['@tiavision/sinter-mail'] })
```

`mail.plain`, `mail.text`, `mail.links` and `mail.unquoted` live in modules that do not
import the parser, so they stay ordinary helpers either way.

A server that sends the tree (`/api/messages/42/body` answering `mail.parse(html, options)` as JSON) is the
cheapest for the browser: on a 2,000-element newsletter, the page's JavaScript is the components' and
sinter's, and the email is painted about 50 ms sooner than when the browser parses it (Chromium).

## `mail.parse(html, options)`

| Option | Values | |
| --- | --- | --- |
| `images` | `'block'` (default), `'allow'`, `'proxy'` | what a remote (`http:`, `https:`) image becomes: left out (its box kept), kept as written, or kept through `proxy` |
| `proxy` | a URL template with `{url}` once | with `images: 'proxy'`: `'/img?url={url}'`; `{url}` is the image's absolute URL, percent-encoded. A path on your site or an `https:` URL |
| `cid` | a map, or a template with `{cid}` once | `cid:` images (inline parts of the message): `{ 'logo@acme': 'data:image/png;base64,…' }` or `'/api/messages/42/parts?cid={cid}'`. An unresolved one is left out |
| `media` | `'wide'` (default), `'narrow'` | the width the email's `@media` rules are evaluated at: 800 px, or 375 px for a narrow reading pane |
| `dataImages` | a length, default 65536 | the largest `data:` image kept, in characters; 0 keeps none |

An invalid option throws at each call (`mail.parse: \`images\` is 'block', 'allow' or 'proxy', not …`). The
same source and options give the same tree, frozen and shared: change a copy (`structuredClone(body)`).

The tree (`Body`) has the email's elements (`type: 'element'`, `tag`, `attrs`, `style`, `children`) and
texts, the body's own `style` (its background and font, rendered on the root), `images.origins`: every
remote image's origin (a left-out pixel's not), sorted, for a "show images from …" control, and `schemes` ([Colour
schemes](#colour-schemes)).

### What is kept

- **71 tags**: text, lists, tables, headings, links, images, and the legacy ones email still uses
  (`<font>`, `<center>`). `<script>`, `<style>` (read for its rules, then dropped), forms and their controls,
  iframes, objects, media, SVG and MathML are dropped with their content. An unknown element (`<o:p>`, a
  custom tag) is a `span`, as the browser renders one.
- **Each tag's own attributes**, values checked: `href` on links, `src`, `alt`, `width`, `height` on images,
  `colspan`, `rowspan` on cells, `role="presentation"` (or `none`) on tables, which email builders write on
  layout tables so a screen reader does not read them as data, and `dir`, `lang`, `title` everywhere. No other
  `role` is kept. No `class`, no `style` attribute (its declarations are in the element's `style`), no
  handler.
- **Links**: `http:`, `https:`, `mailto:` and `tel:`, normalized; anything else loses its `href`. Every link
  opens in a new tab with `rel="noopener noreferrer"`. A `#fragment` link keeps its `href` only when the
  email has its target, which keeps its id, written `mail-…`.
- **Images**: as the options say. `data:` images only as base64 PNG, JPEG, GIF, WebP or AVIF, never SVG.
  An image of at most 1 × 1 pixel (`width` and `height`, as attributes or CSS) is left out, whatever the
  options: it shows nothing, and what it is for is telling the sender when the email was opened.
- **The structure the browser would build**: the parser follows the HTML standard's tree construction
  (implied end tags, tables, misnested formatting), so the tree is the browser's own, and a page built at
  build time is not reparsed into another one. Nesting deeper than 256 elements is flattened.

### Styles

There is no stylesheet. `mail.parse` resolves each element's styles, as a browser's cascade would:

1. its legacy attributes (`bgcolor`, `width`, `align`, `valign`, `border`, `cellpadding`, `cellspacing`,
   `<font color face size>`, `<center>`, `<body text>`), lowest;
2. the email's `<style>` rules that match it, by specificity and order;
3. its `style` attribute; `!important` as CSS says.

It keeps 60 properties (colours, fonts, text, box, borders, table layout, display, float), each
value re-serialized. Selectors with `:hover`, `:focus`, `::before` and the like never match; `@media` rules
are evaluated at the `media` option's width (and `prefers-color-scheme` for both schemes, below); `@import`, `@font-face`, `@keyframes` and `@supports` are
dropped. Never kept: `position`, `z-index`, `transform`, `url()` in any value (background images
included), `var()`, `calc()`, negative margins.

`<mail-body>` writes each element's styles inline, and leaves out what the email hides: an element whose
`display` is `none` at the parsed width is not in the page, nor anything inside it, so a mobile-only copy of
an image is not downloaded on a wide screen (and the other way round), and the page has fewer elements to
build. To follow the reader's width, parse again with the other `media` when it crosses your breakpoint
([`<mail-width>`](#the-readers-width-mail-width) says when): the new tree shows what that width shows, and its
images load then. So:

- **The email's styles win over the page's.** An inline style beats every normal rule of your stylesheets,
  and the legacy attributes are inline too, so `td { padding: 1rem }` in your CSS does not undo
  `cellpadding="0"`.
- **The page fills in what the email does not set.** An email with no font takes the page's font, its
  links your link colour. A plain email looks like part of the app. A mail client shows such an email in
  its own default font (Gmail and Outlook use a sans-serif); to do the same, give the root one:
  `.mail { font-family: Arial, sans-serif; }`.
- **Where your page still wins**: a rule with `!important`, and what the email takes from browser defaults
  when your CSS resets them (a reset that makes images `display: block`, tables full width with padding,
  margins zero, `border-box` sizing). [`mail.css`](#mailcss) gives those defaults back under `.mail`.
- **The email stays in its box.** The root is `display: flow-root`, so floats and margins do not escape it.
  A wide newsletter (600 px of tables) is as wide as it is: `mail.css`'s `mail-scroll` box around
  `<mail-body>` scrolls it sideways on a narrow screen (or parse for the reader's width, with
  [`<mail-width>`](#the-readers-width-mail-width), and it shows its phone layout).

### `mail.css`

An optional stylesheet for apps whose CSS resets the browser's defaults:

```js
import '@tiavision/sinter-mail/mail.css'; // or @import it in your CSS, before its other rules
```

- Tables and images as the browser draws them (`all: revert`): layout tables get no lines or padding, inline
  images stay inline. Images no wider than the reader. `content-box` sizing, which emails' widths are written
  for. Paragraphs, headings, lists and quotes get their margins back.
- `.mail-light`: the light scheme's canvas, text and link colours, for an email written for a white page
  (below).
- `.mail-scroll`, a box you put around `<mail-body>`: an email wider than it scrolls sideways, its background
  covering what scrolls in.
- Every rule is `.mail` (or the class) plus `:where()`: one class's specificity, so it beats a reset's element
  selectors wherever it is imported, and any rule of yours with more specificity beats it. The email's own
  styles are inline and win over all of it.

Compared on real emails (newsletters, legacy HTML, Outlook, Gmail replies, unstyled HTML) in an app with a
reset; without it, an app restores these itself.

### Colour schemes

Most emails are written for a white page: dark text, if they set a colour at all. Some say they work on a dark
one too, and `body.schemes` reports it (`['light', 'dark']`; absent when the email says nothing):

- **declared**: its `color-scheme` or `supported-color-schemes` meta, or `color-scheme` on `<html>` or
  `<body>` (as a style attribute or a rule). The email's colours are kept as written: it is saying they work
  on either page.
- **dark rules**: `@media (prefers-color-scheme: dark)` (or a `<style media>` with it). The cascade runs for
  both schemes, and a colour that differs (`color`, `background-color`, the border and decoration colours) is
  written `light-dark(<light>, <dark>)`, the initial value standing in for a scheme that does not set it
  (`light-dark(currentcolor, #fff)`). The browser picks one by the colour scheme the element is shown in: the
  page's (`<meta name="color-scheme" content="light dark">` follows the system), or what the app sets around
  the body. Then `schemes` includes `dark`.

So an app in dark mode can show an email with `dark` in `schemes` as it is, on its own dark page; an email that
sets no colours takes the page's, light or dark; and one that sets colours of its own without saying they work on
a dark page was written for a white one. `mail.parse` marks that one `body.light` (a text or background colour
anywhere it shows, its body's included, and no `dark` in `schemes`), and `<mail-body>` puts `mail-light` on its
root. [`mail.css`](#mailcss) gives `.mail-light` a light canvas, or write your own:

```css
.mail-light { color-scheme: light; background: Canvas; color: CanvasText; }
.mail-light :where(a) { color: LinkText; }
```

A dark rule's other properties (a light logo hidden, a dark one shown) keep their light values:
`light-dark()` takes colours only.

## Quoted history and signatures

A reply carries the messages it answers. `mail.parse` marks that history `part: 'quote'` and a signature
`part: 'signature'`, from what mail clients write around them; `mail.plain` does the same from `>` lines and
`-- `. They render with the classes `mail-quote` and `mail-signature`, for your styles
(`.mail-signature { opacity: .7 }`), and `body.quotes` says the email has history.

| Client | Quoted history | Signature |
| --- | --- | --- |
| Gmail | `div.gmail_quote` (its "On … wrote:" line inside) | `div.gmail_signature` |
| Apple Mail | `blockquote type="cite"` | |
| Thunderbird | `blockquote type="cite"`, and its "On … wrote:" line (`div.moz-cite-prefix`) | `div.moz-signature` |
| Outlook on the web | from `#appendonsend` (or the rule before `#divRplyFwdMsg`) to the end of its parent | `#Signature` |
| Outlook for Windows | from its header block (From:, Sent:, in any language) to the end of its parent | |
| new Outlook, Outlook on phones | `#mail-editor-reference-message-container` | `#ms-outlook-mobile-signature` |
| Yahoo, Proton | `div.yahoo_quoted`, `.protonmail_quote` | |

Outlook writes no element around its history: the tree wraps it, from the marker to the end of the parent, in
one `div` (the only element the tree adds; blocks to the end of their parent lay out the same in it). A history
that quotes history in turn is a quote in the quote. A plain `<blockquote>` (a newsletter's quotation) is not
history, nor is Apple Mail's "On … wrote:" line, which it writes as an ordinary `div` before its quote.

To show a reply without its history until the reader asks, as mail clients do, render `mail.unquoted(body)`:
the body without the elements of `part: 'quote'`, so a long thread renders only what the reply says.

```html
<article data-sn-state="{ history: false }" data-sn-let="{ tree: mail.parse(msg.html) }">
  <mail-body data-sn-with="{ body: history ? tree : mail.unquoted(tree) }"></mail-body>
  <template data-sn-if="tree.quotes && !history"><button data-sn-on-click="history = true">…</button></template>
</article>
```

`mail.unquoted` returns a copy (the tree is not changed; the same tree gives the same copy), or the body itself
when it quotes nothing or when leaving the quotes out would leave nothing to read: a message forwarded without
a word of its own is all quote (Gmail and Outlook write a forward as they write a reply), and stays whole.

## Images and a proxy

Remote images are left out by default: a tracking pixel never loads, and a left-out image keeps its box
(`width`, `height`, `alt`). The layout stays put when images are shown only if the email gives both sizes,
in attributes or in CSS. An image with only a width (common in responsive templates, `width="600"
height="auto"`) has no height until its first bytes arrive, so the text below it moves when it loads.
`body.images.origins` lists the origins the email would load from.

With a proxy, every remote image goes through your server and the sender never sees the reader's
address, browser, or when the email was opened:

```html
<article data-sn-let="{ body: mail.parse(msg.html, {
           images: 'proxy', proxy: '/api/email/proxy-image?url={url}',
           cid: `/api/email/proxy-image?uid=${msg.uid}&cid={cid}` }) }">
  <mail-body data-sn-with="{ body }"></mail-body>
</article>
```

What the proxy does is yours: which origins it fetches (an allowlist the reader edits), checking the
address (no private or loopback targets, no redirects to them), serving only what the bytes show is an
image, with `X-Content-Type-Options: nosniff`. A proxy that fetches only when an image is shown tells
the sender when the email was opened (from the server's address, not the reader's); one that fetches
when the email arrives does not, at the cost of fetching images nobody looks at. A proxy that answers a
refused image with a transparent pixel shows an empty box; once the reader allows an origin, put a
version in the template (`'/img?v=3&url={url}'`) so the browser does not keep the pixel.

The tree never rewrites the email's HTML, so a reply or a forward quotes the original image URLs.

## Plain text: `mail.plain(text, options)`

The same tree from a `text/plain` body: paragraphs with their line breaks (`white-space: pre-wrap`),
URLs, `www.` addresses and email addresses as links (GFM's rules), `>` quotes as nested blockquotes
(`mail-quote`), and everything after a `-- ` line as the signature (`mail-signature`).

| Option | |
| --- | --- |
| `flowed: true` | the text is `format=flowed` (RFC 3676): soft line breaks (a trailing space) are joined back into paragraphs, so they reflow on narrow screens. The flag is in the message's `Content-Type` |
| `delsp: true` | with `flowed`: `DelSp=yes`, the space before a soft break is removed too |

## `mail.text(node)` and `mail.links(body)`

`mail.text` is the text of a body or node, blocks separated by newlines, hidden content left out: for
previews and search snippets. `mail.links` is every link with its text, in order.

## The reader's width: `<mail-width>`

An email's `@media` rules are decided when it is parsed, for one width: `media: 'wide'` (800 px) or `'narrow'`
(375 px, its phone layout). `<mail-width>` says which one fits the space the email is shown in, and says it
again when the reader is resized across the breakpoint:

```html
<main data-sn-state="{ media: /** @type {'wide' | 'narrow' | null} */ (null) }">
  <mail-width data-sn-on-media="media = $event.detail"></mail-width>
  <mail-body data-sn-with="{ body: media ? mail.parse(message.html, { media }) : null }"></mail-body>
</main>
```

Parse only once `media` is known, as above: the email is parsed once, for the right width. Starting with a
width instead (`'wide'`) parses twice on a phone, and the first parse's images (the desktop hero) are requested
before the second replaces it. Waiting costs under a frame: `<mail-width>` reports as it is put in the page
(in Chromium, the email was in the page 9 ms later than with a fixed `media`).

- Put it in the same box as `<mail-body>`: it measures its own width, an empty `<div aria-hidden="true">` of
  no height, as wide as the box.
- Its `media` event is `'narrow'` below `breakpoint` (640 px by default; mobile layouts are written for 480 to
  640 px) and `'wide'` above, once when it is first laid out and again at each crossing, never while the
  width stays on one side. Another breakpoint: `<mail-width data-sn-with="{ breakpoint: 560 }">`.
- The new parse is another tree (cached as every parse is: switching back costs nothing): what the new width
  hides is left out and what it shows renders, its images loading then.
- It needs the browser (a `ResizeObserver`); a static page chooses its `media` at build time. In a reader that
  is hidden (`display: none`) it reports once the reader is shown.
- The state's type is written with a JSDoc cast, as state is typed by its initial value.

## How `<mail-body>` renders

`<mail-body>` picks one of two ways to render each use, and the build ships only the one it picks:

- **Templates**, when the build knows the email (a `file:` resource: the page gets plain HTML, no
  JavaScript), when the use fills the `link` or `image` slot, or when it passes `templates: true`.
- **A script builder** otherwise, which is every email that arrives from an API without slot fills. It
  creates the elements with `createElement`, `setAttribute` and `style.setProperty`, with the same checks as
  `data-sn-attr` and `data-sn-style` (sinter's `attrAllowed` and `styleAllowed`), and it never writes HTML.
  On the 2,000-element newsletter it renders about 7 times faster than the templates.

The choice is made per use at build time, with sinter's `$build` and `$slots`, so a page with only
API emails does not ship the templates:

```html
<mail-body data-sn-with="{ body }"></mail-body>                   <!-- script builder -->
<mail-body data-sn-with="{ body, templates: true }"></mail-body>  <!-- templates -->
```

### The first email: `<mail-warm>`

The first email a page parses is its slowest: the browser compiles a function when it first runs and
optimises it from what it has seen it do, so the parser's first run takes three to four times as long as a
later one, and it takes about three large emails before it is at speed. `<mail-warm>` on the page that will
show an email does that work beforehand:

```html
<mail-warm></mail-warm>
```

While the page is idle (the reader looks at the list, a message is on its way, a PGP mail is being decrypted)
it parses and builds two dozen sample emails written as mail is written: a builder's newsletter, an Outlook
thread, a Gmail reply. Nothing of them reaches the page or `mail.parse`'s cache; it renders an empty hidden
element. Measured in Chromium, from an email's last byte to the email painted, first email of a page:

| | without | with `<mail-warm>` | a later email |
| --- | --- | --- | --- |
| a reply, 3 kB | 20 ms | 16 ms | 12 ms |
| an Outlook thread, 39 kB | 34 ms | 22 ms | 17 ms |
| a newsletter, 185 kB | 68 ms | 32 ms | 24 ms |
| a digest, 285 kB, 2,575 elements | 69 ms | 45 ms | 43 ms |

It costs about 150 ms of idle time, in slices, and 4.5 kB gzip on the pages that have it, and changes nothing
for a later email.

`sinter({ compileHints: true })` asks V8 to compile the page's module as it loads. It shortens the first
parse a little (the newsletter's script 47 to 39 ms) and adds nothing measurable on a page with `<mail-warm>`.

An app that has an email's HTML before its reader opens (a prefetch on hover, the next unread message) can
also call `mail.parse` then: the tree is kept by its source, and the click finds it.

### Against an iframe

What a mail app usually does instead is sanitize the HTML with DOMPurify and show it in a sandboxed iframe.
Measured against that (as [Caley](https://git.tia.sh/tia/Caley) did it before it moved to this library: its
sanitizer and its frame, without `allow-same-origin` for decrypted mail, which Chrome then runs in a process
of its own), `first email / a later one`, in ms:

| | `<mail-body>`, with `<mail-warm>` | DOMPurify and an iframe | the same, isolated |
| --- | --- | --- | --- |
| a reply, 3 kB | 16 / 14 | 29 / 17 | 41 / 37 |
| a receipt, 20 kB | 20 / 13 | 35 / 35 | 47 / 40 |
| an Outlook thread, 39 kB | 22 / 16 | 35 / 35 | 54 / 40 |
| a newsletter, 185 kB | 32 / 24 | 107 / 73 | 106 / 95 |
| a digest, 285 kB | 45 / 41 to 54 | 120 / 121 | 138 / 118 |

DOMPurify's time is calls into the DOM, which do not get faster with use; the HTML is parsed twice; and an
isolated frame is parsed, laid out and painted in another process. The page with the parser is 51 kB gzip of
JavaScript (55 kB with `<mail-warm>`), the one with DOMPurify 26 kB. How it was measured, and what else was
tried: [docs/proposals/html-from-api.md](proposals/html-from-api.md) (`bench/html.mjs`).

A tree parsed on the server is still the cheapest for the browser: the page ships no parser (about 15 kB gzip
of JavaScript in total) and only builds the elements.

## Long messages

The script builder renders the 2,000-element newsletter whole in about 35 ms (Chromium), about the time the
first part of a progressive render used to take, so `<mail-body>` no longer renders in steps. `mail.progressive`
is deprecated: it gives the body back as it is, and will be removed; drop the call.

## Changing how links and images look

`<mail-body>` has two slots. A fill reads the element as `$slot.node`:

```html
<mail-body data-sn-with="{ body }">
  <a slot="link" target="_blank" rel="noopener noreferrer nofollow" data-sn-attr="{ href: $slot.node.attrs.href, title: $slot.node.attrs.href }"><slot></slot></a>
  <template slot="image" data-sn-if="$slot.node.attrs.src"><img loading="lazy" data-sn-attr="{ src: $slot.node.attrs.src, alt: $slot.node.attrs.alt, width: $slot.node.attrs.width, height: $slot.node.attrs.height, srcset: null }"></template>
  <template data-sn-else><span class="blocked" data-sn-text="$slot.node.attrs.alt ?? 'image'"></span></template>
</mail-body>
```

`<slot></slot>` in the link's fill is the link's content. A fill that writes the element itself drops its
styles unless it binds them (`$slot.node.style`).

## Content Security Policy

An email rendered in the browser (HTML or a tree from an API) needs nothing beyond
`script-src 'self'; style-src 'self'; require-trusted-types-for 'script'`: styles are set with
`style.setProperty`, which a policy does not block, and nothing is written as HTML.

An email folded at build time (a `file:` email, or a page that renders it in its first frame) has its
styles in `style` attributes, which `style-src 'self'` blocks: the email then shows without its look. Such
a page needs `style-src-attr 'unsafe-inline'` (or `'unsafe-inline'` in `style-src`). The values are the
cascade's, sanitized: no `url()`, no escapes, no property outside the list.

## Security

What `mail.parse` guarantees, whatever the email:

- **Nothing runs.** No script, handler, `javascript:` or `data:` link, SVG, form or iframe survives; the
  tree has no way to hold one (each tag's attributes are a fixed list, written as literal keys), and
  sinter's runtime checks every URL it sets once more.
- **Nothing loads without your consent.** Remote images only under `'allow'` or through your proxy; no
  CSS `url()`, `@import` or `@font-face`; no other element that loads.
- **Nothing reaches outside the email's box.** No `position` or negative margins; no stylesheet, so no
  rule of the email applies to the page; no classes; ids only as in-email link targets, prefixed.
- **Bounded work.** Linear parsing, nesting bounded, a budget on selector matching (2 million steps) and
  at most 10,000 style rules per email; a plain-text body makes at most 2,000 links, the rest stays text. A
  hostile email of a megabyte parses in well under a second.

Rendering each body of a message on its own (never joining bodies into one HTML string) keeps PGP/MIME
open for later (EFAIL's direct exfiltration needs joined parts); reading MIME is not part of the library
yet.

## Limits

- Only the email's own styles and the browser's: no `:hover`, no animation, no web fonts, no background
  images.
- `@media` is decided at parse time, for one width (`media`), not as the reader resizes: parse again with
  the other `media` to switch, when [`<mail-width>`](#the-readers-width-mail-width) says so. Only the colour scheme follows the page, and only for colours (`light-dark()`).
- Quirks mode is not followed: class names match case-sensitively and unitless lengths are dropped.
- The parser's size: about 40 kB gzip with the cascade. The HTML parser is about 17.5 kB of it, nearly half of
  that the HTML standard's entity table, and the cascade about 19 kB. A server that sends the tree ships
  none of it.
- A very large email may exceed sinter's budget of components expanded at build time (10,000): it then
  renders in the browser (SN536).
- Tested in Chromium; Firefox and Safari are not yet part of the tests.
