# Email

`@tiavision/sinter-mail` shows the body of an email in a sinter app, without an iframe. `mail.parse`
turns an email's HTML into a tree, `mail.plain` does the same for a plain-text email, and `<mail-body>`
renders the tree as part of the page: it scrolls, selects, searches and prints with it, and takes the
page's fonts where the email sets none.

```html
<sn-resource name="msg" src="/api/messages/{$url.id}"></sn-resource>
<article data-sn-let="{ body: msg.html ? mail.parse(msg.html, { images: 'proxy', proxy: '/img?url={url}' }) : mail.plain(msg.text) }">
  <mail-body data-sn-prop="{ body }"></mail-body>
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
  plugins: [sinter({ components: ['@tiavision/sinter-mail'] })],
});
```

```ts
// src/sinter.helpers.ts: the helpers, as the namespace `mail`
export * as mail from '@tiavision/sinter-mail';

// src/sinter.types.ts: the tree's types, for your own declarations
export type { Body, Element } from '@tiavision/sinter-mail';
```

sinter-mail needs a sinter with the changes made for it (the branch `ccr-dc349183-ubeji7` of
tiaforge/sinter, until they are released).

## Three places, one function

`mail.parse(html, options)` is a pure function, so sinter runs it wherever its argument is:

| The email | Where it is parsed | What the page ships |
| --- | --- | --- |
| A file: `src="file:./welcome.html"` | at build time | the email as plain HTML, no JavaScript |
| HTML from an API, in a `data-sn-let` | in the browser, once per source and options | the parser, about 32 kB gzip, and the components, about 16 kB |
| The same, with the package lazy | in the browser, once the parser has loaded | the parser in a chunk of its own |
| A tree from your API (`mail.parse` run on the server, in Node) | on the server | no parser: the components only |

To make the parser lazy, list the package in `lazy`; a let that calls `mail.parse` is `undefined` until the
parser has arrived, and `<mail-body>` with no body renders an empty `<div class="mail">`:

```js
sinter({ components: ['@tiavision/sinter-mail'], lazy: ['@tiavision/sinter-mail'] })
```

`mail.plain`, `mail.text` and `mail.links` live in modules that do not import the parser, so they stay
ordinary helpers either way.

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
texts, the body's own `style` (its background and font, rendered on the root), and `images.origins`: every
remote image's origin, sorted, for a "show images from …" control.

### What is kept

- **71 tags**: text, lists, tables, headings, links, images, and the legacy ones email still uses
  (`<font>`, `<center>`). `<script>`, `<style>` (read for its rules, then dropped), forms and their controls,
  iframes, objects, media, SVG and MathML are dropped with their content. An unknown element (`<o:p>`, a
  custom tag) is a `span`, as the browser renders one.
- **Each tag's own attributes**, values checked: `href` on links, `src`, `alt`, `width`, `height` on images,
  `colspan`, `rowspan` on cells, `dir`, `lang`, `title` everywhere. No `class`, no `style` attribute (its
  declarations are in the element's `style`), no handler.
- **Links**: `http:`, `https:`, `mailto:` and `tel:`, normalized; anything else loses its `href`. Every link
  opens in a new tab with `rel="noopener noreferrer"`. A `#fragment` link keeps its `href` only when the
  email has its target, which keeps its id, written `mail-…`.
- **Images**: as the options say. `data:` images only as base64 PNG, JPEG, GIF, WebP or AVIF, never SVG.
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
are evaluated at the `media` option's width; `@import`, `@font-face`, `@keyframes` and `@supports` are
dropped. Never kept: `position`, `z-index`, `transform`, `url()` in any value (background images
included), `var()`, `calc()`, negative margins.

`<mail-body>` writes each element's styles inline. So:

- **The email's styles win over the page's.** An inline style beats every normal rule of your stylesheets,
  and the legacy attributes are inline too, so `td { padding: 1rem }` in your CSS does not undo
  `cellpadding="0"`.
- **The page fills in what the email does not set.** An email with no font takes the page's font, its
  links your link colour. A plain email looks like part of the app. A mail client shows such an email in
  its own default font (Gmail and Outlook use a sans-serif); to do the same, give the root one:
  `.mail { font-family: Arial, sans-serif; }`.
- **Where your page still wins**: a rule with `!important`, and what the email takes from browser defaults
  when your CSS resets them (a reset that makes images `display: block`, headings unsized, lists unmarked).
  For newsletters exactly as sent, restore the defaults under `.mail` in your stylesheet.
- **The email stays in its box.** The root is `display: flow-root`, so floats and margins do not escape it.
  A wide newsletter (600 px of tables) is as wide as it is: put `<mail-body>` in a box with
  `overflow-x: auto` for narrow screens.

Quotes and signatures that `mail.plain` finds carry the classes `mail-quote` and `mail-signature`, for
your styles (`.mail-signature { opacity: .7 }`).

## Images and a proxy

Remote images are left out by default: a tracking pixel never loads, and a left-out image keeps its box
(`width`, `height`, `alt`), so the layout does not move when images are shown. `body.images.origins` lists
the origins the email would load from.

With a proxy, every remote image goes through your server and the sender never sees the reader's
address, browser, or when the email was opened:

```html
<article data-sn-let="{ body: mail.parse(msg.html, {
           images: 'proxy', proxy: '/api/email/proxy-image?url={url}',
           cid: `/api/email/proxy-image?uid=${msg.uid}&cid={cid}` }) }">
  <mail-body data-sn-prop="{ body }"></mail-body>
</article>
```

What the proxy does is yours: which origins it fetches (an allowlist the reader edits), checking the
address (no private or loopback targets, no redirects to them), serving only what the bytes show is an
image, with `X-Content-Type-Options: nosniff`, fetching when the email arrives so opening it is not
tracked. A proxy that answers a refused image with a transparent pixel shows an empty box; once the
reader allows an origin, put a version in the template (`'/img?v=3&url={url}'`) so the browser does not
keep the pixel.

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

## Long messages: `mail.progressive(body)`

A long email (a newsletter of 2,000 elements) takes one task of about 45 ms to render, and nothing of it
shows until that task ends; on a phone, several times that. Number the body with `mail.progressive`, and
`<mail-body>` renders it progressively: the first part in the task that receives the body, the rest in steps
after the browser has painted that, a task each.

```html
<sn-resource name="message" src="/api/messages/{$url.id}"></sn-resource>
<mail-body data-sn-prop="{ body: mail.progressive(message.tree) }"></mail-body>
```

`mail.progressive(body, head = 200)` numbers the nodes in document order and sets `body.head` (the first 200
nodes render first) and `body.first` (the body up to there). Run it in the page, as above, or on the server
before the tree is sent; there, `body.first` repeats the first nodes in the JSON (about 18% more for the
newsletter, less after gzip). A body that is not numbered renders whole in one task, as before, so short
emails are not affected.

Measured on the 2,000-element newsletter (Chromium, [measurements](proposals/progressive-rendering.md)): the
email starts to show after about 50 ms instead of about 100; the rest renders in steps of 5 to 15 ms, each
sized by how long the one before took (about 12 ms of script, so a step fits in a frame on any device), with
input and paint between them; the whole email is in place about 6% later than when the rest renders in one
task, and no frame is dropped.

- **Static pages are not affected.** The steps need a script, which only the progressive branch of
  `<mail-body>` has: an email from a file is not numbered, the build decides that branch away, and the page
  ships no JavaScript. Calling `mail.progressive` on a static page's body is `SN322` (the page would ship
  JavaScript).
- **One element more.** A progressive render ends with a hidden empty element (`<i hidden>`, the component
  that runs the steps) at the end of the email: a selector like `:last-child` in the app's CSS sees it.
- **The slots work as before.** Fills render in every step.

## Changing how links and images look

`<mail-body>` has two slots. A fill reads the element as `$slot.node`:

```html
<mail-body data-sn-prop="{ body }">
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
- `@media` is decided at parse time, for one width (`media`), not as the reader resizes.
- Quirks mode is not followed: class names match case-sensitively and unitless lengths are dropped.
- The parser's size: about 32 kB gzip with the cascade, most of it the HTML standard's entity table and
  tree construction. A server that sends the tree ships none of it.
- A very large email may exceed sinter's budget of components expanded at build time (10,000): it then
  renders in the browser (SN536).
- Tested in Chromium; Firefox and Safari are not yet part of the tests.
