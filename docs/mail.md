# Email

`@tiavision/sinter-mail` shows the body of an email in a sinter app, without an iframe. `mail.parse`
turns an email's HTML into a tree, `mail.plain` does the same for a plain-text email, `mail.mime` reads a whole
message (its parts, attachments and OpenPGP structure), and `<mail-body>` renders the tree as part of the page: it scrolls, selects, searches and prints with it, and takes the
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

sinter-mail needs sinter 0.22.0 or later.

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

`mail.plain`, `mail.text`, `mail.links`, `mail.unquoted`, `mail.bytes` and `mail.imageType` live in modules that
do not import the parser, so they stay ordinary helpers either way. `mail.mime` imports the MIME reader, a chunk of
its own, and is lazy as `mail.parse` is ([Lazy](#lazy)).

A server that sends the tree (`/api/messages/42/body` answering `mail.parse(html, options)` as JSON) is the
cheapest for the browser: on a 2,000-element newsletter, the page's JavaScript is the components' and
sinter's, and the email is painted about 50 ms sooner than when the browser parses it (Chromium).

## `mail.parse(html, options)`

| Option | Values | |
| --- | --- | --- |
| `images` | `'block'` (default), `'allow'`, `'proxy'` | what a remote (`http:`, `https:`) image becomes: left out (its box kept), kept as written, or kept through `proxy` |
| `proxy` | a URL template with `{url}` once | with `images: 'proxy'`: `'/img?url={url}'`; `{url}` is the image's absolute URL, percent-encoded. A path on your site or an `https:` URL |
| `cid` | a map, or a template with `{cid}` once | `cid:` images (inline parts of the message): `{ 'logo@acme': 'blob:…' }` (a raster `data:` URL, a `blob:` URL, a path or an `https:` URL; [from `mail.mime`](#attachments-and-inline-images-mailbytes-mailimagetype)) or `'/api/messages/42/parts?cid={cid}'`. An unresolved one is left out |
| `media` | `'wide'` (default), `'narrow'` | the width the email's `@media` rules are evaluated at: 800 px, or 375 px for a narrow reading pane |
| `dataImages` | a length, default 65536 | the largest `data:` image kept, in characters; 0 keeps none |
| `legacyDisplay` | `true`, `false` (default) | the part has `hp-legacy-display="1"` in an encrypted payload (RFC 9788; a `mail.mime` part's `legacyDisplay`): every `div` in the body with class `header-protection-legacy-display` is left out with its content. Without the option a class drops nothing |
| `encrypted` | `true`, `false` (default) | the body was decrypted (a `mail.mime` part's `protection.encrypted`): remote images are blocked whatever `images` says (no request a decrypted body makes on its own), `images.origins` still listed. `cid:` and `data:` images are unaffected |
| `consent` | `true`, `false` (default) | with `encrypted`: the reader clicked "show images" for this message; `images` applies again. Never a standing per-sender setting ([Images in decrypted parts](#images-in-decrypted-parts)) |

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

## Whole messages: `mail.mime(bytes, options)`

`mail.mime` reads a whole message, the bytes of an `.eml` (RFC 5322 and MIME), into what a reader shows: the
headers, each body ready for `mail.parse` or `mail.plain`, the attachments, the inline images and what was
malformed. Bodies are never joined: each is a part of its own, in reading order, with what protected it.

```html
<main data-sn-state="{ results: /** @type {MimeOptions} */ ({}) }">
  <sn-resource name="raw" call="rawMessage($url.id)"></sn-resource>
  <article data-sn-let="{ msg: raw ? mail.mime(raw, results) : null }">
    <template data-sn-if="msg">
      <sn-resource name="cids" call="inlineImages(raw, msg, results)" when="msg"></sn-resource>
      <h1 data-sn-text="msg.headers.subject ?? '(no subject)'"></h1>
      <template data-sn-for="p in msg.parts">
        <template data-sn-if="p.type === 'html'">
          <mail-body data-sn-with="{ body: mail.parse(p.html, { cid: cids?.[p.id], legacyDisplay: p.legacyDisplay, encrypted: p.protection.encrypted }) }"></mail-body>
        </template>
        <template data-sn-else data-sn-if="p.type === 'text'">
          <mail-body data-sn-with="{ body: mail.plain(p.text, { flowed: p.flowed, delsp: p.delsp }) }"></mail-body>
        </template>
      </template>
    </template>
  </article>
</main>
```

```ts
// src/sinter.types.ts: the message's types, beside the tree's
export type { Body, Element, Message, MimeOptions, Part, Attachment, Ref } from '@tiavision/sinter-mail';
```

```ts
// src/sinter.actions.ts: the message's bytes, as a Uint8Array (a string is read as UTF-8)
import type { CallContext } from '@tiaforge-ui/sinter';

export async function rawMessage(id: string, ctx: CallContext): Promise<Uint8Array> {
  const res = await fetch(`/api/messages/${encodeURIComponent(id)}/raw`, { signal: ctx.signal });
  if (!res.ok) throw new Error(`the message: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
```

The bytes are kept as they arrived (a resource, or state) and never changed; the message is computed from them, and from the results of [the steps](#encrypted-and-signed-mail)
when the message is encrypted or signed. It runs in the browser, on a server (Node) and at build time, over an
`.eml` in a `file:` resource (read as text: keep such a fixture 7-bit, its 8-bit parts quoted-printable or base64).

### The message

| Field | |
| --- | --- |
| `parts` | what to show, in reading order (below) |
| `attachments` | every part that is not shown: `id`, `filename` (made safe), `originalFilename` (as sent, for display only, never for saving), `contentType` (as declared, lowercased, not trusted), `disposition`, `kind`, `contentId`, `size` (decoded), `ref`, `protection` |
| `calendar` | each `text/calendar` part (iMIP invitations): `part`, `method`, `text` and the `attachment` that saves it. The text is for an iCalendar parser, never HTML |
| `headers` | the headers to show: `subject`, `from`, `sender`, `replyTo`, `to`, `cc`, `date`, `messageId`, `inReplyTo`, `references`, `list` (List-Id, List-Unsubscribe, List-Unsubscribe-Post), `autocrypt`, `raw` (every field, unfolded, not decoded) |
| `outer` | the headers as transported; the same as `headers` unless protected headers apply ([below](#encrypted-and-signed-mail)) |
| `sources` | for each shown field, `'protected'` or `'outer'` |
| `reply` | whom a reply goes to |
| `confidential` | header names, lowercase, that the sender sent only encrypted |
| `hpOuter` | the payload root's `HP-Outer` fields, `[name, value]` with the name lowercase: what the outer header said, for [an unencrypted reply](#replies); only with `hp="cipher"` in a decrypted root, else empty |
| `steps`, `summary` | what the app is asked to decrypt or verify, and what it proved ([below](#encrypted-and-signed-mail)); for plain mail no steps and `{ encrypted: 'none', signed: 'none', from: null }` |
| `problems` | what was malformed, refused or repaired: `{ code, part, blocking }`, never content |

An address is `{ name, address }`: `address` is `null` when the address is ambiguous or malformed (never a guess),
`group` names its group, and `suspicious: true` marks a display name that holds `@` or `<` and is not the address
itself, or an address in a form other software reads differently (a route, `%` or `!` in the local part, a domain
literal). Show such an address in full. A `date` is ISO 8601 in the sender's offset (`2026-11-24T09:30:00+01:00`;
`-00:00` when the zone is unknown), `null` when it does not parse. Every decoded value has its control and
bidirectional characters removed, so a header reused in a reply cannot add another.

Ids are paths, as IMAP numbers parts: the root is `1`, its parts `1.1`, `1.2`, theirs `1.2.1`, through nested
messages too; inside a decrypted payload they continue after the step's id (`1#3f…/1.2`). A nested message's
multipart root shares the id of its `message/rfc822` part, as in IMAP; when that root is shown whole (an encrypted
part, or one attachment of its bytes) it is `<id>.1`, so no two parts or attachments have the same id, but its
problems still name the message part. The same bytes and options give the same ids.

### Parts

| `type` | Holds | Goes to |
| --- | --- | --- |
| `'html'` | `html`, `legacyDisplay`, `inline` | `mail.parse(p.html, { cid, legacyDisplay: p.legacyDisplay, encrypted: p.protection.encrypted })` |
| `'text'` | `text`, `flowed`, `delsp` | `mail.plain(p.text, { flowed: p.flowed, delsp: p.delsp })` |
| `'message'` | `message` (a `Message`, with its own `summary`), `ref` | a forwarded `message/rfc822` shown inline: render its parts as these |
| `'report'` | `text` | a delivery or read report (`message/delivery-status` and the like): `mail.plain(p.text)` |
| `'encrypted'` | `ref`, `step`, `reason` | what the reader cannot read yet: `'pending'`, `'failed'`, `'not-root'` (the reader may open it) or `'over-limit'` ([below](#encrypted-and-signed-mail)) |

Every part also has `id`, `contentType` and `protection`. Your own options (`images`, `proxy`, `media`) go into
`mail.parse` as for any email: `encrypted` overrides `images` for a decrypted body, and the rest are the part's own.

What is shown, by structure:

- `multipart/alternative`: its last part that can be shown, `prefer` choosing between an HTML and a text one. A text
  alternative that is wholly one PGP armored or cleartext-signed block is chosen whatever `prefer` says. The
  alternatives not chosen are neither parts nor attachments, but the attachments inside them are attachments.
- `multipart/related`: its root (`start`, else the first part); the others are attachments of kind `'related'`.
- `multipart/mixed`, `multipart/digest` and unknown multiparts: each part, in order. A `text/plain` or `text/html`
  part is shown unless it is `Content-Disposition: attachment` or has a filename; everything else is an attachment.
- `multipart/report`: the human part, the report parts, and the returned message as a `'message'` part.
- `message/rfc822` and `message/global`: inline, a `'message'` part; as an attachment, of kind `'message'`, which
  `mail.mime` reads again from `mail.bytes`.
- `text/calendar`: in `calendar`, and an attachment of kind `'calendar'`. `application/pgp-keys`: of kind
  `'pgp-keys'`, for an "import key" control. `.pgp`, `.gpg` and `.asc` files: of kind `'encrypted'`, which the
  app may decrypt as files.
- Never opened: `message/partial` (not reassembled), `message/external-body` (nothing fetched), TNEF
  (`winmail.dat`) and uuencoded text. Vendor headers (`X-Mozilla-External-Attachment-URL`) are in `raw` and do
  nothing.

Charsets are the parts' own, through `TextDecoder` with the WHATWG labels: no charset is UTF-8, invalid UTF-8 is
read as windows-1252, and an unknown label (UTF-7 included) is read as UTF-8 with a `charset-unknown` problem. An
HTML part's `<meta charset>` is ignored.

### Attachments and inline images: `mail.bytes`, `mail.imageType`

The message holds no bytes: an attachment, an encrypted part and a step hold a `Ref` (a byte range and its transfer
encoding), and `mail.bytes(raw, ref, { decrypted })` returns the bytes it names, decoded, as a new array over its
own `ArrayBuffer` (a `Uint8Array<ArrayBuffer>`, which `new Blob([…])` takes as it is).
`decrypted` (the same results as `mail.mime`'s) is needed for a Ref inside a decrypted payload; a Ref outside its
source, or whose payload has no `'ok'` result, throws a `TypeError`.

An HTML part's `inline` lists the images it may show, `{ contentId, attachment }`: the parts of its own
`multipart/related`, and parts elsewhere in the message whose Content-ID is unique (at most 64), only with the same
`protection` as the body. A Content-ID twice in a message resolves to nothing. `Content-Location` is never resolved.

Inline images go to `mail.parse` as blob URLs, made in an action. **The type comes from the bytes**:
`mail.imageType(bytes)` is `'png'`, `'jpeg'`, `'gif'`, `'webp'` or `'avif'` by the magic number, or `null`, and
never SVG whatever the part declares. A blob URL has the page's origin, so this check is what keeps an attachment
from opening as a document there:

```ts
// src/sinter.actions.ts: each HTML part's cid map, part id → Content-ID → blob URL
import * as mail from '@tiavision/sinter-mail';
import type { Message, MimeOptions } from '@tiavision/sinter-mail';

export async function inlineImages(raw: Uint8Array, msg: Message, results: MimeOptions): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const p of msg.parts) {
    if (p.type !== 'html') continue;
    const cid: Record<string, string> = {};
    for (const { contentId, attachment } of p.inline) {
      const a = msg.attachments.find((x) => x.id === attachment)!;
      const bytes = await mail.bytes(raw, a.ref, results);
      const type = await mail.imageType(bytes);   // the type from the bytes, never the declared one
      if (type) cid[contentId] = URL.createObjectURL(new Blob([bytes], { type: `image/${type}` }));
    }
    out[p.id] = cid;
  }
  return out;
}
```

Revoke the URLs (`URL.revokeObjectURL`) when the reader leaves the message. To save an attachment, read its bytes
the same way, offer them as `application/octet-stream` under `filename`, never under the declared type, and show
one inline only by your own allowlist of types checked on the bytes. A server that serves the parts instead (a `cid`
template, as before) applies the same rule.

### Options

| Option | Values | |
| --- | --- | --- |
| `prefer` | `'html'` (default), `'text'` | in a `multipart/alternative`, between an HTML and a text part |
| `decrypted` | `{ [step id]: Decrypted }` | the app's results for decrypt steps |
| `verdicts` | `{ [step id]: Verdict[] }` | the app's results for verify steps |
| `open` | step ids | the encrypted parts the reader chose to open |

`decrypted` and `verdicts` are plain objects (not `Map`s). An invalid option throws a `TypeError` at each call
(`mail.mime: \`prefer\` is 'html' or 'text', not "x"`), as does a result with an unknown `status`, an `'ok'` one
without `plaintext` (a `Uint8Array`) or without `integrity`, or a verdict whose `signer` is not an array of strings.
A result or an `open` id that matches no step of this message is ignored, with a `stale-result` problem: results
of another message (or of an earlier version of this one) never apply.

### The cache

The same bytes and options give the same message, frozen at every depth and JSON-shaped (it can be cloned, sent
from a server, folded at build time). As a let is read again and again, `mail.mime` keeps its last message: the
input compared by identity (a typed array is never compared byte by byte), `prefer` by value, and each result
entry by key and by identity. Behind it, a cache of 32 inputs and 16 MiB (the inputs, an estimate of each message
kept, and the plaintexts the kept options hold), 4 option sets per input.

So **never change an input or a result in place**: a `Uint8Array` written into, or a stored `Decrypted` whose
`plaintext` is replaced, gives the message read before. Store a new array or a new result object instead; the
options object itself may be new at every read.

The kept messages hold decrypted text, and the kept options their plaintexts. When the reader locks the app or
logs out, call `mail.forget()` in an action (awaited, which a lazy package needs: its stubs allow calls, not a
property such as `mail.mime.clear`), as well as dropping the results from state: it drops every message kept and
the plaintexts it holds, and the next call reads again. `mail.mime.clear()` is the same, for code that holds the
function itself.

### Lazy

`mail.mime` lives in its own module, which imports the reader as `@tiavision/sinter-mail/mime`: with the package in
`sinter({ lazy })`, the reader is a chunk of its own (about 24 kB gzip with `mail.mime`, apart from the HTML
parser) and a let that calls `mail.mime` is `undefined` until it has loaded. Guard it (`data-sn-if="msg"`). `mail.bytes` and
`mail.imageType` import no reader and stay ordinary helpers.

In an action module, every import of a lazy package is a stub that returns a Promise, so every call of it is
awaited: `await mail.mime(…)`, `await mail.bytes(…)`, `await mail.imageType(…)`, even though they are synchronous in
the package. The examples here await them; awaiting is harmless when the package is not lazy.

### Problems

`problems` lists each code once per part. A **blocking** one is structure that parsers read differently (two
boundaries, a duplicate Content-Type, a boundary that is a prefix of its parent's, a control byte in a structural
field): the message is still shown as a tolerant client shows it, but no step is offered in, above or below it, so
its parts are never badged. Three blocking problems are about the app's results, not the structure: `integrity`,
a `limit` for a plaintext over 64 MiB, and a `limit` for a part opened past the step limit. They are listed as
blocking and fail their step (the part shows nothing), but stop nothing around them: a signature the encrypted
part is under keeps its step and its label. Informational ones (`charset-fallback`, `canonicalized`,
`no-header-end`, …) change nothing. Show at most a generic "this message is malformed"; the codes are for logs and tests.

## Encrypted and signed mail

`mail.mime` never decrypts or verifies, and holds no keys. When a message is OpenPGP (PGP/MIME, RFC 3156, or inline
PGP), `steps` lists what the app must do; the app reads the bytes with `mail.bytes`, does it with its own OpenPGP
library, and calls `mail.mime` again with the result. The library checks the structure strictly, reads the decrypted
payload, applies protected headers and labels each part; keys, decryption, verification and whom to trust are the
app's.

| Step `kind` | Holds | The app |
| --- | --- | --- |
| `'decrypt'` | `ciphertext` (a Ref), `armored` | decrypts it and stores a `Decrypted` under the step's `id` in `decrypted` |
| `'verify'` | `signed`, `signature` (Refs), `micalg` | verifies the detached signature over `signed` and stores `Verdict[]` in `verdicts` |
| `'verify-cleartext'` | `block` (a Ref), `charset` | verifies the cleartext-signed block, decoded with `charset`, and stores `Verdict[]` |

Every step has `id`, `part` and `state`: `'pending'` without a result, `'done'` with one accepted, `'failed'` with one
refused. A step's id carries a digest of its bytes (`1#3fa2…`), so a result applies only to the bytes it is for. A
decrypted payload can ask for more steps (a signature inside, a second encryption): call again until none is pending.

```ts
interface Decrypted {
  status: 'ok' | 'failed' | 'no-key' | 'locked' | 'unsupported';
  plaintext?: Uint8Array;     // with 'ok'
  integrity?: boolean;        // required with 'ok': an integrity-protected packet decrypted completely,
                              // and the message was encrypted; anything but true shows nothing
  signatures?: Verdict[];     // signatures inside the ciphertext
}

interface Verdict {
  status: 'good' | 'bad' | 'no-key' | 'expired' | 'revoked' | 'unsupported';
  fingerprint?: string;
  created?: string;
  signer?: string[];          // the addresses of the key's user IDs that the app trusts as the key's
}
```

### The action

The page keeps the results in state, and the message is computed from them:

```html
<main data-sn-state="{ results: /** @type {MimeOptions} */ ({}), consent: false }">
  <sn-resource name="raw" call="rawMessage($url.id)" then="run('unlock')"></sn-resource>
  <span hidden id="unlock" data-sn-call="unlock(raw, results, null)" data-sn-then="results = $result"></span>
  <article data-sn-let="{ msg: raw ? mail.mime(raw, results) : null }">
    <template data-sn-if="msg">
      <template data-sn-for="p in msg.parts">
        <template data-sn-if="p.type === 'encrypted' && p.reason === 'not-root'">
          <button data-sn-call="unlock(raw, results, p.step)" data-sn-then="results = $result">Open the encrypted part</button>
        </template>
        <!-- the other parts as above -->
      </template>
    </template>
  </article>
</main>
```

```ts
// src/sinter.actions.ts: the steps run with openpgp.js until none is pending
import * as mail from '@tiavision/sinter-mail';
import * as openpgp from 'openpgp';
import type { Decrypted, MimeOptions, Ref, Step, Verdict } from '@tiavision/sinter-mail';
import { keyring, type Keyring } from './lib/keyring';
// yours: { me: the reader's private key, unlocked, or null; known: [{ key, addresses }] }, the public keys the app
// knows, each with the addresses the app trusts it for (a user ID it has checked, a contact the reader confirmed)

type Results = Required<Pick<MimeOptions, 'decrypted' | 'verdicts' | 'open'>>;

/** the results with every step settled; `open`: a part the reader chose to open, or null */
export async function unlock(raw: Uint8Array, prior: MimeOptions, open: string | null): Promise<Results> {
  const r: Results = { decrypted: { ...prior.decrypted }, verdicts: { ...prior.verdicts }, open: [...(prior.open ?? [])] };
  if (open !== null && !r.open.includes(open)) r.open.push(open);
  const ring = await keyring();
  // each round settles every pending step, and a message has at most 16
  for (let round = 0; round <= 16; round++) {
    const msg = await mail.mime(raw, r);
    const pending = msg.steps.filter((s) => s.state === 'pending');
    if (!pending.length) break;
    for (const s of pending) {
      if (s.kind === 'decrypt') r.decrypted[s.id] = await decrypt(await mail.bytes(raw, s.ciphertext, r), ring);
      else r.verdicts[s.id] = await verify(s, (ref) => mail.bytes(raw, ref, r), ring);
    }
  }
  return r;
}

async function decrypt(ciphertext: Uint8Array, ring: Keyring): Promise<Decrypted> {
  if (!ring.me) return { status: 'locked', integrity: false };
  try {
    const text = new TextDecoder().decode(ciphertext);
    const message = text.includes('-----BEGIN PGP MESSAGE-----')
      ? await openpgp.readMessage({ armoredMessage: text })
      : await openpgp.readMessage({ binaryMessage: ciphertext });
    // a signed or literal message is not encrypted: never 'ok'
    const ids = message.getEncryptionKeyIDs();
    if (!ids.length) return { status: 'failed', integrity: false };
    if (!ids.some((id) => id.toHex() === '0000000000000000' || ring.me!.getKeys(id).length)) return { status: 'no-key', integrity: false };
    const { data, signatures } = await openpgp.decrypt({
      message, decryptionKeys: ring.me, verificationKeys: ring.known.map((k) => k.key), format: 'binary',
      config: { allowUnauthenticatedMessages: false },   // no MDC, a failed MDC, a partial plaintext: refused
    });
    return { status: 'ok', plaintext: data as Uint8Array, integrity: true, signatures: await Promise.all(signatures.map((s) => verdict(s, ring))) };
  } catch {
    return { status: 'failed', integrity: false };
  }
}

async function verify(step: Step, get: (ref: Ref) => Uint8Array | Promise<Uint8Array>, ring: Keyring): Promise<Verdict[]> {
  const keys = ring.known.map((k) => k.key);
  try {
    if (step.kind === 'verify') {
      const sig = await get(step.signature);
      const text = new TextDecoder().decode(sig);
      const signature = text.includes('-----BEGIN PGP SIGNATURE-----')
        ? await openpgp.readSignature({ armoredSignature: text })
        : await openpgp.readSignature({ binarySignature: sig });
      const message = await openpgp.createMessage({ binary: await get(step.signed) });
      const { signatures } = await openpgp.verify({ message, signature, verificationKeys: keys });
      return Promise.all(signatures.map((s) => verdict(s, ring)));
    }
    if (step.kind === 'verify-cleartext') {
      const cleartextMessage = new TextDecoder(step.charset).decode(await get(step.block));
      const message = await openpgp.readCleartextMessage({ cleartextMessage });
      const { signatures } = await openpgp.verify({ message, verificationKeys: keys });
      return Promise.all(signatures.map((s) => verdict(s, ring)));
    }
  } catch {
    return [{ status: 'unsupported' }];
  }
  return [];
}

async function verdict(sig: openpgp.VerifyMessageResult['signatures'][number], ring: Keyring): Promise<Verdict> {
  const known = ring.known.find((k) => k.key.getKeys(sig.keyID).length);
  if (!known) return { status: 'no-key' };
  const fingerprint = known.key.getFingerprint();
  try {
    await sig.verified;
  } catch {
    return { status: 'bad', fingerprint };
  }
  // signer: only the addresses the app trusts as this key's, never every user ID the key claims
  return { status: 'good', fingerprint, signer: known.addresses };
}
```

- **Decrypt reports `integrity` honestly.** `true` only when the app checked an integrity-protected packet (SEIPD
  with its MDC, or AEAD) decrypted completely, and that the input was an encrypted message: with openpgp.js,
  `allowUnauthenticatedMessages: false`, a whole (not streamed) decryption, and `getEncryptionKeyIDs()` not empty.
  Without it the library shows nothing (`integrity` problem, the step `'failed'`): this is what stops EFAIL's
  modified ciphertexts.
- **Verify returns `signer` only from user IDs the app trusts.** A key can claim any address in its user IDs;
  `signer` is what binds a signature to the From, so it is the app's trust decision, not the key's claim. A good
  signature from a key the app does not trust for any address is `good` with no `signer`. Distinguish `expired`
  and `revoked` when your library tells you.
- **Store the results in state**, by step id, as the action returns them: a new object each time. Keep them per
  message (the page's state is), and drop them when the reader leaves it.
- With the package in `lazy`, every `mail.*` call in the action is awaited (above). With `openpgp` in `lazy` too,
  every `openpgp.*` call is awaited, as here.

### What the summary means

Each part and attachment has a `protection`: `encrypted` (decrypted from a ciphertext), `opened` (from a part the
reader opened), `signed` (the innermost signature over it: a verdict's status, `'pending'`, or `null`), its `step`
and `signer`. `summary` is over the whole message, the parts and attachments of nested messages included:

| `summary` | Values | |
| --- | --- | --- |
| `encrypted` | `'all'`, `'some'`, `'none'` | `'all'`: everything shown came from the root's ciphertext; an opened part makes it `'some'` |
| `signed` | `'all'`, `'some'`, `'none'` | `'all'`: one good signature covers the message's root (or the decrypted payload's root), its `signer` includes the From shown, and every part and attachment is `good` with that From among its signers; anything less with a good signature is `'some'` |
| `from` | `'matches'`, `'differs'`, `'unknown'`, `null` | `'matches'`: a good signature over the root whose `signer` includes the From shown. `'differs'`: protected headers name another From than the outer one. `'unknown'`: anything else encrypted or signed (encrypted but unsigned, signed by another key, a signature over one part), and always when any part was opened. `null`: nothing encrypted or signed |

How to show it:

- **A message-level badge only for `'all'`.** "Encrypted" for `encrypted: 'all'`, "Signed by …" for
  `signed: 'all'`. `'some'` is what an attacker builds (a genuine signed snippet inside other text), and also a
  mailing list's footer under a signed message: mark the parts instead, from each one's `protection`.
- **The badge is on the body, not the headers.** A field whose `sources` is `'outer'` was not covered by any
  signature: a signed body under an unsigned Subject can be re-sent in another context.
- **Warn on `from`**: `'differs'` or `'unknown'` means the sender shown is not the one the cryptography proves.
  Encryption alone proves nothing about the author: anyone with the reader's public key can encrypt. With
  `'differs'`, `headers.from` is the outer From; show the protected one beside it as a claim.
- **Opened parts apart**: a part with `protection.opened` was decrypted from inside someone else's message (a
  forward, a list footer around it). Show it in a box of its own, labelled, never as the message's own content.
- **A signature outside a ciphertext labels nothing inside it.** Anyone can sign someone else's ciphertext: in
  sign over encrypt (a `multipart/signed` around the `multipart/encrypted`), and in a signed multipart around a
  part the reader opened, the outer signature covers the ciphertext only. Its verify step is offered, so the app
  may say who sent the ciphertext on, but its verdict labels no part of the plaintext, is no signature over the
  payload's root and binds no From. The decrypted parts carry the signatures inside the ciphertext
  (`Decrypted.signatures`), or `signed: null`.
- **A nested message has its own `summary`**, by the same rules over its own parts, but it has no steps of its
  own: `encrypted` is `'all'` only when it lies wholly inside the root's ciphertext (`'some'` when anything in it is
  opened), and `from` is `null` or `'unknown'`, never `'matches'`.
- `encrypted` parts that are `'pending'` say why nothing shows yet; `'failed'` that the app's result was refused.

### Opening an encrypted part: `open`

Only the message's root is decrypted on its own: content decrypted from inside another sender's message cannot be
told apart from theirs, and a reply would quote it back to them. Any other encrypted structure (inside a forward,
armor with a footer around it, one part among several) is an `'encrypted'` part with `reason: 'not-root'`, and no
step. Its `step` is the id its decrypt step would have: when the reader chooses to open it, put that id in `open`
(the button above), and the next `mail.mime` call offers the step. What it decrypts to is shown in its place,
`protection.opened`, never applies protected headers, makes `summary.from` `'unknown'` (so a reply does not quote it
as the sender's), and makes `encrypted` `'some'`. An encrypted part in a nested message is opened the same way, through the outer message's `steps`.

### Images in decrypted parts

`mail.parse(p.html, { …, encrypted: p.protection.encrypted })` blocks remote images in a decrypted body whatever
`images` says: a decrypted body makes no request on its own (EFAIL's channel, and a read receipt for content the
sender meant to be private). `body.images.origins` is still reported. When the reader clicks "show images" for this
message, add `consent: true`, and `images` applies again:

```html
<template data-sn-if="p.type === 'html'">
  <div data-sn-let="{ body: mail.parse(p.html, { images: 'proxy', proxy: '/img?url={url}', cid: cids?.[p.id], legacyDisplay: p.legacyDisplay, encrypted: p.protection.encrypted, consent }) }">
    <mail-body data-sn-with="{ body }"></mail-body>
    <template data-sn-if="body && p.protection.encrypted && !consent && body.images.origins.length">
      <button data-sn-on-click="consent = true">Show images</button>
    </template>
  </div>
</template>
```

Consent is per message, never a standing per-sender setting. `cid:` and `data:` images are the message's own and
unaffected.

### Protected headers

An encrypted (or signed) payload may carry the real headers (RFC 9788's `hp` parameter, or the older
`protected-headers="v1"`): the outer Subject is then often `...`. `headers` shows them once the payload counts
(decrypted, or signed with a good verdict), and `sources` says which fields came from inside. The protected From
replaces the outer one only with a good signature whose `signer` includes it; otherwise `headers.from` is the outer
From and `summary.from` says whether they differ. List headers, Autocrypt and `raw` are always the outer ones:
nothing outside the payload should change what the app does with encrypted content. An HTML part with
`legacyDisplay: true` holds the sender's copy of the headers for old clients, which `mail.parse` drops with
`legacyDisplay`; a text part has it removed already.

### Replies

- **Address a reply to `reply`.** For an encrypted payload with protected headers it is the protected Reply-To,
  else the protected From, so a reply to a re-sent ciphertext goes to its author, not to whoever re-sent it; empty
  when the payload names neither (ask the reader). In a decrypted payload without protected headers, nothing binds the outer Reply-To: `reply` is the
  outer From when a signature inside the ciphertext binds it, else empty (a re-sent ciphertext, or one re-sent as
  inline armor, which strips its headers, must not send a reply quoting it to whoever re-sent it). Otherwise (no
  encryption) the shown Reply-To, else the shown From.
- **Quote decrypted content only when `summary.from` is `'matches'`**, or after asking: otherwise the outer sender
  may have wrapped someone else's ciphertext to read it back from your reply.
- **An unencrypted reply leaves out what was confidential.** Each name in `confidential` was sent only encrypted:
  in a reply that is not encrypted, use the value the sender gave for the outside, its entry in `hpOuter` (with
  `protected-headers="v1"`, which has no `HP-Outer`, the field in `outer`), or leave the field out when it has
  none.

### What the library never does

It holds no key, decrypts nothing, verifies nothing and decides no trust: those are the app's, in an action, a
server or a hardware key. Its one hash, SHA-256, binds a result to the bytes it is for and proves nothing else. It
never decrypts anything but the root on its own, never takes a result without `integrity: true`, never badges a part
a blocking problem touches, never applies a protected From without a signature that binds it, never makes a step
from armor in HTML, in a quote or in an alternative not shown, and decrypts a forward's or a footer-wrapped
ciphertext only when the reader opens it.

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
thread, a Gmail reply. Nothing of them reaches the page or `mail.parse`'s cache, and nothing of them is
requested: their elements are made in a document without a window, where an image does not load. It renders an
empty hidden element. Measured in Chromium, from an email's last byte to the email painted, first email of a page:

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

What `mail.mime` guarantees, whatever the message:

- **Bounded work, no throw.** Linear in the input, walked without deep recursion: nesting at most 32 levels, 1,000
  parts, 8 nested messages, 16 steps, header blocks of 1 MB (the root) and 64 kB (a part) with 1,000 fields, 1,000
  addresses per field; 256 MiB read per call, a decrypted payload at most 64 MiB, the payloads counted in the same
  budget. Past a limit, an entity is an attachment of its bytes and a `limit` problem. Malformed mail reads as a
  tolerant client reads it, with a problem; only invalid options throw.
- **Bodies are never joined.** Each body is a part of its own, rendered on its own, with its own protection: EFAIL's
  direct exfiltration needs joined parts. An inline image belongs to its body and to the body's protection.
- **Decoding never creates structure.** Encoded words are decoded after the header is tokenized and only in names
  and text, so a decoded `<`, `@` or line break is text; controls and bidirectional characters are removed from
  every decoded value; an ambiguous address is `null`, never a guess; filenames are made safe (no path, no
  bidirectional trick, no reserved name).
- **Content types are not trusted.** An inline image becomes a URL only by its magic number, never as SVG;
  calendar text is never HTML; nothing an attachment declares is acted on.
- **A badge never covers more than the cryptography proves.** Labels are per part; `'all'` needs one good signature
  over the root bound to the From; only the root is decrypted on its own, and only with `integrity: true`; a
  blocking problem near a signature or a ciphertext means no step; results are bound to their bytes by digest. The
  badge rules are in [What the summary means](#what-the-summary-means).

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
- `mail.mime` reads OpenPGP only: S/MIME (`application/pkcs7-mime`) is an attachment, not a step, until it gets step
  kinds of its own.
- `message/partial` is not reassembled, `message/external-body` fetches nothing, and TNEF (`winmail.dat`) and
  uuencoded blocks are not opened: they are attachments, or text, as they are.
- Charsets come from `TextDecoder`: Node built without full ICU lacks the CJK and some single-byte decoders, and
  such parts are read as UTF-8 with a `charset-unknown` problem (a build that folds an `.eml` runs in Node).
- The reader's ambiguity rules follow the MIME ambiguity Internet-Draft and the papers it summarizes; the Inbox
  Invasion measurement paper (CCS 2024) itself was not read, so a class it found that the draft does not name may be
  missed.
- The reader is about 23 kB gzip, apart from the HTML parser.
