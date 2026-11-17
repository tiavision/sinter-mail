# Proposal: sinter-mail, email bodies rendered by sinter templates

Status: proposed. Nothing is built yet. Sections are numbered in the order of the [Plan](#plan); every
design choice is recorded in [Decisions](#decisions), and what is left depends on measurements
([Open questions](#open-questions)).

## Goals

`@tiaforge-ui/sinter-mail` shows the body of an email in a sinter app, the way
[sinter-markdown](https://github.com/tiaforge/sinter/tree/main/packages/sinter-markdown) shows markdown:

- **No iframe.** The email is part of the page: it scrolls, sizes, selects and prints with it, and the
  page's styles fill in what the email does not set.
- **The email's own look.** Its `<style>` rules, inline styles and legacy attributes (`bgcolor`,
  `cellpadding`, `<font>`) are kept, and win over the page's styles.
- **All markup comes from sinter templates.** sinter never creates HTML from data, and this library does
  not change that: the email is parsed into a tree, and components render the tree, element by element.
  No `innerHTML`, no `srcdoc`, no stylesheet built from data, no change to sinter's core.
- **Three places, one function**, as for markdown: an email in a file is plain HTML at build time and
  ships no JavaScript; an email from an API is parsed in the browser (the parser with the page, or lazy);
  an API may run the parse itself and send the tree, and the page ships no parser.
- **Plain-text email too**, through the same tree and the same components.
- **Safe for hostile input**, under `script-src 'self'; style-src 'self'; require-trusted-types-for
  'script'`: nothing an email contains runs, loads from the network without the app's consent, or
  reaches outside its own box.

### Not in version 1

Listed so that version 1 does not close them off ([Later](#later)): reading MIME messages, PGP/MIME, a
proxy for remote images, detecting and collapsing quoted replies in HTML email, background images.

## The case

An app that shows email today has two choices:

| | iframe (`srcdoc`, sandboxed) | sanitize, then `innerHTML` |
| --- | --- | --- |
| Styles | isolated both ways | the email's `<style>` leaks into the page, or is dropped |
| Layout | the iframe's height must be measured and set by script, and is wrong until then | part of the page |
| Under sinter | `srcdoc` is `SN207`; the iframe needs script | `innerHTML` is `SN207`; Trusted Types need a policy |
| First frame | empty, then the email | the email, if rendered on the server |
| From a file | a document per email | a sanitizer in the build |

Email is a good fit for sinter's model because email HTML is already constrained. Senders write for
clients that strip most of CSS (Gmail, Outlook), so an email's look is in inline styles, table
attributes and one `<style>` block that inliner tools are made for. No script, form or iframe is
expected to work. The compromises a renderer without a stylesheet must make are the ones email clients
already make, and those are the ones this library makes.

## What sinter has to build on

Everything below exists in sinter 0.19 and is used as it is:

- **Component libraries** ([libraries](https://github.com/tiaforge/sinter/blob/main/docs/libraries.md)):
  a package ships source in `sinter/`, public and internal components, one prefix, helpers re-exported
  under a namespace the app chooses.
- **Pure helpers fold at build time**: a helper over a constant (a `file:` resource) runs in the build,
  if it uses only the language's own globals, `URL`, `URLSearchParams`, `structuredClone`,
  `TextEncoder` and `TextDecoder`. `src="file:./welcome.html"` reads any file but `.md` and `.json` as
  its text.
- **`memo()`** (`@tiaforge-ui/sinter/memo`) keeps a helper's results: same input, same frozen tree.
- **Choosing a component by data**: `<sn-component use="{ p: 'mail-p', … }[node.tag]">`, one choice per
  node; in a library, the map form names every candidate (`SN312`).
- **Text runs** as `<template data-sn-text>`, a text node with no element.
- **Tree slots**: a public root declares a slot, internal components place it (`SN331`).
- **`data-sn-attr`** with literal keys; URL attributes checked at runtime (`http:`, `https:`,
  `mailto:`, `tel:`, relative; `data:` and `blob:` only in media `src`).
- **`data-sn-style`** with literal property names, set with `style.setProperty`; `null` removes the
  property; a value with `url(`, `image(`, `image-set(` or a backslash is refused at runtime.
- **Lazy packages**: `sinter({ lazy: ['@tiaforge-ui/sinter-mail'] })` covers the package's subpaths, so
  the parser, imported as `@tiaforge-ui/sinter-mail/parser`, loads on first need; a helper module that
  does not import it stays an ordinary helper.

What sinter does not have, and this proposal does not add: a way to bind a stylesheet, a `<style>`, a
`style` attribute or arbitrary property names from data. Those stay closed ([Decisions](#decisions), 1).

## The package

```
package.json              @tiaforge-ui/sinter-mail, "sinter": "./sinter", exports ".", "./parser"
sinter/
  components/
    mail-body.html        public: one body, HTML or plain text
    internal/
      mail-node.html      one element, by its tag: the only place elements are dispatched
      mail-p.html …       one component per allowed tag (generated, committed)
  sinter.helpers.ts       re-exports parse.ts, plain.ts, tree.ts
  parse.ts                mail.parse: imports the parser, sanitizes, resolves styles
  plain.ts                mail.plain: plain text to the same tree; imports no parser
  tree.ts                 mail.text, mail.links: read a tree; import no parser
  parser.js               the HTML and CSS parser, prebundled (generated; committed)
  sinter.types.ts         the tree's types
  index.ts                the entry
scripts/
  tags.mjs                the tag table: tags, their attributes, their style properties
  build-components.mjs    writes components/internal/ from the table; --check
  build-parser.mjs        writes parser.js; --check
fixtures/                 pages for sinter check; a corpus of real emails
test/
docs/
```

The prefix is `mail-`, the namespace an app writes `mail`:

```ts
// src/sinter.helpers.ts
export * as mail from '@tiaforge-ui/sinter-mail';
```

```html
<sn-resource name="msg" src="/api/messages/{$url.id}"></sn-resource>
<article data-sn-let="{ body: msg.html ? mail.parse(msg.html, { images: 'block' }) : mail.plain(msg.text) }">
  <mail-body data-sn-prop="{ body }"></mail-body>
</article>
```

## Design

### 1. The tree

`mail.parse` and `mail.plain` return the same type, deep-frozen:

```ts
interface Body { type: 'body'; children: Node[]; images: ImageInfo; }
type Node = Element | Text;
interface Text { type: 'text'; value: string; }
interface Element {
  type: 'element';
  tag: Tag;                       // one of the allowed tags, lowercase
  attrs: Attrs;                   // only the tag's allowed attributes, values checked
  style: Style;                   // resolved declarations, only allowed properties
  part?: 'quote' | 'signature';   // what the element is in the message
  children: Node[];
}
interface ImageInfo { blocked: number; }   // remote images left out, for "show images"
```

- **One node per element the browser would build**, no more: the parse produces the tree that the
  browser's own parser builds from the same HTML, restricted to the allowed tags (section 2). A tree
  that differs would be reparsed into another one when a page built at build time loads.
- **`part`** marks what the app may want to style or fold. In version 1, `mail.plain` sets it for
  quotes and the signature; detecting quotes in HTML email sets the same field later.
- **No classes.** Every selector is resolved at parse time (section 4), so the email's class names are
  not needed, and keeping them would let the page's rules for `.button` or `.header` reach the email by
  accident. They are dropped.
- **Ids** are kept only when an in-email link points to them (`href="#top"`), and written as
  `'mail-' + id` (`SN503`), with the link rewritten to match.
- An API can send this tree instead of the HTML (`mail.parse` run on the server, in Node): the
  components render it as any other data.

### 2. Parsing HTML

The parser turns email HTML into the tree of section 1. It is prebundled into `parser.js`, committed,
and checked by `npm run build:parser -- --check`, as sinter-markdown's is.

- **The tree must match the browser's.** That means HTML's tree construction for what emails contain:
  implied end tags (`<p>`, `<li>`, `<td>`, `<tr>`, `<option>`), void elements, `<tbody>` inserted into a
  table that has none, content outside cells moved before the table, misnested inline tags (`<b><i></b>`),
  `<html>`, `<head>` and `<body>` implied, and the head's `<style>` blocks collected. Full HTML5 tree
  construction (frames, `<template>`, foreign content beyond what is dropped, scripting flags) is not
  needed: those parts of a document are dropped anyway.
- **The candidates** are a tokenizer from htmlparser2 with a tree builder of our own for the rules above,
  or parse5 trimmed to what is used. The spike decides on size and on the corpus test (section 9).
  parse5 is the reference in the tests either way.
- **Entities** decode from a table, never through the DOM, as in sinter-markdown (the same packed table).
- **Charset** is not the parser's job: it takes a string. Decoding bytes is the caller's (the API, or
  later the MIME step).
- **Linear** in the input: a test parses long runs of open tags, attributes and entities within a second.
- **Limits**: nesting deeper than a bound (256) is flattened, as browsers bound theirs; the bound is an option.

### 3. What an email may contain

A tag table (`scripts/tags.mjs`) is the single source for what is allowed. From it come the parser's
allowlist, the tree's `Tag` type and the generated components.

- **Tags, about 60**: the text and structure tags (`p`, `div`, `span`, `h1`–`h6`, `br`, `hr`, `b`,
  `strong`, `i`, `em`, `u`, `s`, `strike`, `small`, `sub`, `sup`, `code`, `pre`, `blockquote`, `q`,
  `ul`, `ol`, `li`, `dl`, `dt`, `dd`, `a`, `img`, `abbr`, `cite`, `mark`, `kbd`, `address`, `wbr`), the
  table tags (`table`, `caption`, `colgroup`, `col`, `thead`, `tbody`, `tfoot`, `tr`, `th`, `td`), the
  legacy tags email still uses (`font`, `center`), and `section`, `article`, `header`, `footer`,
  `main`, `nav`, `aside`, `figure`, `figcaption`, `details`, `summary`.
- **Unknown or unwanted tags** have two fates, as in the table: content tags (`custom-tag`, `o:p`,
  `label`) are unwrapped, their children kept; dangerous or empty ones (`script`, `style` after it is
  read, `iframe`, `object`, `embed`, `form` and its controls, `svg`, `math`, `video`, `audio`,
  `canvas`, `link`, `meta`, `base`, `title`, `template`, `noscript`) are dropped with their content.
- **Attributes per tag**, literal in the components: `href` and `title` on `a`; `src`, `alt`, `width`,
  `height` on `img`; `colspan`, `rowspan`, `headers`, `scope` on cells; `start`, `reversed`, `type` on
  lists; `dir` and `lang` everywhere; `open` on `details`. The legacy presentational attributes are read
  by the parser and turned into styles (section 4); they are not rendered as attributes, except `width`
  and `height` on images, which also reserve the image's space.
- **Links**: `http:`, `https:`, `mailto:`, `tel:` and in-email `#fragments`; anything else is dropped by
  the parser, and the runtime's check stays as a second gate. Every `<a>` gets `target="_blank"` and
  `rel="noopener noreferrer"`, written literally in its component.
- **Images** (`images` option):
  - `'block'` (the default): a remote image is left out; its box keeps its `width` and `height` and
    its `alt` text, so the layout does not move when images are shown. `body.images.blocked` counts
    them, for a "show images" button that parses again with `'allow'`.
  - `'allow'`: `http:` and `https:` images are kept.
  - `cid:` images are kept when the `cid` option maps them (`{ 'logo@acme': '/att/12' }` or a function);
    an unmapped one is left out. `data:` images are kept up to a size bound (an option).
  - Images bind `srcset: null`, so an app's image pipeline does not resize user content (as
    sinter-markdown's `md-image`).
- **Comments, processing instructions, conditional comments** (`<!--[if mso]>`) are dropped. Outlook's
  conditional content is for Outlook; what other clients show is what is outside it.

### 4. Styles

The email's styles are resolved by the parser into each element's `style`, and rendered inline. There is
no stylesheet.

**Resolving.** For each element, in the order of the cascade:

1. The legacy attributes, turned into declarations, as the browser's presentational hints rank them
   (lowest): `bgcolor` to `background-color`, `width` and `height`, `align` to `text-align` (and
   `margin-inline: auto` for a centred table), `valign` to `vertical-align`, `border` to the table's
   and its cells' borders, `cellpadding` to the cells' `padding`, `cellspacing` to `border-spacing`,
   `<font color face size>` to `color`, `font-family`, `font-size`, `<center>` to `text-align: center`.
2. The `<style>` rules that match it, by specificity and order, `!important` last.
3. Its `style=""` attribute, `!important` in it last.

Then only the allowed properties are kept, and the result is the element's `style`.

- **Selectors**: type, class, id, attribute (`[align=center]`), universal, descendant, child, adjacent
  and general sibling, `:first-child`, `:last-child`, `:nth-child()`, `:not()` of those, matched against
  the parsed tree. A rule with a selector outside that (`:hover`, `::before`, `:focus`) is dropped.
- **At-rules**: `@media` is resolved by the `media` option: `'wide'` (the default) drops its rules,
  `'narrow'` applies those for a width below 600 px, which email layouts are written for, so an app
  that shows email in a narrow column can choose the mobile layout. `@import`, `@font-face`, `@keyframes`,
  `@supports` and the rest are dropped. A `@media` rule cannot follow the viewport, since there is no
  stylesheet: the choice is made at parse time.
- **Properties, about 40** (`scripts/tags.mjs`): `color`, `background-color`, the `font-*` longhands,
  `line-height`, `letter-spacing`, `text-align`, `text-decoration`, `text-transform`, `text-indent`,
  `white-space`, `vertical-align`, `width`, `height`, `min-`/`max-width`, `min-`/`max-height`,
  `padding-*`, `margin-*`, `border-*` longhands, `border-radius`, `border-collapse`, `border-spacing`,
  `table-layout`, `display` (`block`, `inline`, `inline-block`, `none`, the table values), `list-style-type`,
  `overflow` (`hidden`, `visible`), `opacity`, `box-sizing`. Shorthands are expanded at parse time.
  Not allowed: `position`, `z-index`, `transform`, `filter`, `animation`, `transition`, `content`,
  `cursor`, `pointer-events`, `background-image` and any value with `url(`, custom properties and
  `var()`, `expression()`.
- **Values** are re-serialized from the parsed tokens, so CSS escapes are decoded (`"\5FAE\8F6F"` is
  written as the characters), no backslash remains, and the runtime's style check never refuses a
  value the parser kept. A value is kept when it parses as the property's grammar allows, in a simple
  form (lengths, percentages, colours, keywords, font lists); `calc()` is not kept in version 1.
- **The CSS parser** is a tokenizer after CSS Syntax Level 3 and a small selector parser, bundled into
  `parser.js` with the HTML parser.

**Rendering.** Each generated component binds the element's resolved style with a literal list:

```html
<template data-sn-component="{ node: Element }"><td data-sn-attr="{ colspan: node.attrs.colspan, rowspan: node.attrs.rowspan, … }" data-sn-style="{ color: node.style.color, 'background-color': node.style['background-color'], … }"><template data-sn-for="c in node.children"><template data-sn-if="c.type === 'text'" data-sn-text="c.value"></template><template data-sn-else><mail-node data-sn-prop="{ node: c }"></mail-node></template></template></td></template>
```

- Each tag lists the properties that do something on it (no `border-spacing` on a `<span>`), so a
  binding reads about 15 to 40 properties. A missing property is `undefined`: nothing is written. The
  spike measures the cost on a large newsletter (section 9).
- **The email wins over the page.** Inline styles beat every normal rule of the page's stylesheets,
  whatever their specificity; the legacy attributes are inline too, so a page rule `td { padding: 1rem }`
  does not undo `cellpadding="0"`.
- **The page fills in.** What the email does not set comes from the page: the font, the colour, link
  styles, line height. A plain email looks native to the app.
- **Where the page still wins**: a page rule with `!important` (`data-sn-style` sets no priority), and
  whatever the email takes from browser defaults when the page resets them (a reset that makes images
  `display: block` or headings unsized). That is the app's choice. A recipe shows an opt-in reset to
  browser defaults under `.mail` for apps that want designed newsletters exactly as sent.

### 5. Plain text

`mail.plain(text, options)` is in `plain.ts`, which imports no parser: it stays an ordinary helper when
the package is lazy, and folds at build time over a `file:` resource.

- **Paragraphs**: text between blank lines is a `<p>` with `white-space: pre-wrap`, so line breaks and
  spacing are as written.
- **Links**: URLs, `www.` addresses and email addresses become links, with GFM's autolink rules
  (sinter-markdown's `autolink.js`, copied with its tests: the same organisation and licence).
- **Quotes**: lines starting with `>` become `blockquote` elements with `part: 'quote'`, nested per level (`> >`).
  Space-stuffed lines (`format=flowed`) are read as RFC 3676 says.
- **Signature**: from a line that is exactly `-- ` to the end is a `div` with `part: 'signature'`.
- **`flowed: true`** (with `delsp`) joins soft line breaks back into paragraphs, as RFC 3676 says, so
  they reflow on narrow screens. The flag is in the message's `Content-Type`, so the caller passes it.
- **Linear** in the text, and the same limits as `mail.parse`.

### 6. The components

- **`<mail-body>`** takes `body` and renders `<div class="mail">` with the body's children; with no
  `body`, an empty `<div class="mail">` (a lazy parser that has not arrived). It declares the slots.
- **`<mail-node>`** (internal) is the dispatch: its root is `<sn-component use="{ p: 'mail-p', … }[node.tag]">`.
  Every loop over children renders text runs first and `<mail-node>` for each element, so the map is
  written once.
- **One component per tag** (internal, generated by `scripts/build-components.mjs` from the tag table,
  committed, `--check` in the tests): the element with its literal attribute and style lists and the
  loop over its children, written without whitespace between tags (whitespace is text, and would show
  in tables and phrasing content).
- **Constant parts**: `part` adds the class `mail-quote` or `mail-signature`, a literal class the page
  styles (`.mail-signature { opacity: .7 }`).
- **Slots, version 1**: `link: Slot<{ node: Element }>` (a warning before an outgoing link, a link
  whose text and address differ) and `image: Slot<{ node: Element }>` (a placeholder for a blocked
  image, a lightbox). Placed by `mail-a` and `mail-img` as their roots, defaults inside, as
  sinter-markdown's are. More slots later are additive.
- **Tables** render as components like everything else; a `<template>` is allowed in a table by the
  HTML parser, so a row loop inside `<tbody>` stays where it is written.

### 7. Three places, one function

| Email body | Where it is parsed | What the page ships |
| --- | --- | --- |
| A file: `src="file:./welcome.html"` | at build time | the email as plain HTML with inline styles, no JavaScript |
| A string from an API, in a `data-sn-let` | in the browser, once per source and options (`memo()`) | the parser with the page |
| The same, with the package lazy | in the browser, once the parser has loaded | the parser in a chunk of its own |
| A tree from the API (`mail.parse` run on the server) | on the server | no parser |

`mail.parse` keeps its trees as `md.parse` does: same source and same normalized options, same frozen
tree, about 8 MiB of trees kept, the least recently used dropped first.

### 8. Reading a tree

`tree.ts`, no parser: `mail.text(node)` (the text of a node, for previews and search snippets) and
`mail.links(body)` (every link, for an app that lists or checks them).

### 9. Tests

| Test | What it covers |
| --- | --- |
| `parse.test.ts` | `mail.parse` and its options; the tag and attribute allowlists; URLs; ids; linear time on hostile runs |
| `styles.test.ts` | the cascade: legacy attributes, specificity, `!important`, `@media` both ways, selectors kept and dropped, escapes decoded, nothing the runtime refuses |
| `corpus.test.ts` | real emails (newsletters, receipts, notifications, Outlook, Gmail, Apple Mail and inliner output): our tree equals the browser's own parse of the same HTML restricted to the allowed tags (parse5 in Node, the DOM in Chromium), and serializing our tree and parsing it again gives the same tree |
| `plain.test.ts` | paragraphs, links, quotes, signature, `format=flowed` |
| `components.test.ts` | the tag table, the `Tag` type, the dispatch map and the component files agree; generated files up to date |
| `check.test.ts` | `sinter check` over the fixture pages: no error, no warning |
| `static.test.ts` | an email from `file:` built with `sinter({ static })`: no JavaScript, the styles inline |
| `browser.test.ts` | the fixture app in Chromium, Firefox and WebKit under `script-src 'self'; style-src 'self'; require-trusted-types-for 'script'`, failing on any violation or console error; a corpus of hostile emails (script in every place, `javascript:` and `data:` links, CSS with `url()`, `expression()`, escapes, `position: fixed` overlays): no request leaves the page, nothing outside `.mail` changes; screenshots of corpus emails against an iframe rendering of the same HTML, as a measure of fidelity |

## Decisions

1. **No stylesheet sink in sinter's core.** Binding a stylesheet from data would open what sinter's
   security model keeps closed. The cascade is resolved at parse time instead, and email is where that
   costs least: email clients already drop most of what this drops.
2. **Email, not HTML in general.** The tag set, the styles kept, the image policy and the parser's
   scope are email's. The name says so; a request for more of HTML is judged by what email clients do.
3. **The page's styles reach the email; the email's win.** No isolation layer: inline styles override
   the page, the page fills in the rest, and a plain email looks like part of the app.
4. **Legacy attributes become inline styles**, so the page cannot undo them by accident.
5. **Classes are dropped** after the cascade is resolved; ids are kept only as link targets, prefixed.
6. **Remote images are blocked by default**, with their boxes kept, so tracking pixels need the app's
   consent and showing images does not move the layout.
7. **One tag table generates the allowlists, the types and the components**, so they cannot disagree.
8. **Plain text is in version 1**, through the same tree, in a module without the parser.
9. **One document per body.** A body is parsed and rendered on its own; bodies are never joined. This
   keeps MIME and PGP/MIME open ([Later](#later)): EFAIL's direct exfiltration relies on parts joined into
   one document.
10. **No MIME in version 1.** The caller passes a decoded string, and a map for `cid:` images.

## Plan

1. **Spike**: the parser candidates against the corpus (size, speed, tree equality); the style binding's
   cost on the largest corpus email (render time, bundle size of the generated components). Not merged.
2. The tag table, the tree's types, `build-components.mjs`, `<mail-body>` and `<mail-node>`, over
   hand-written trees.
3. `mail.parse`: HTML, the allowlists, URLs, images, ids.
4. Styles: the CSS parser, the cascade, legacy attributes, `@media`.
5. `mail.plain`.
6. `mail.text`, `mail.links`, the slots.
7. The corpus, hostile and browser tests; the docs page and a recipe (an inbox with a message pane,
   plain and HTML messages, "show images").

## Open questions

- **The parser**: htmlparser2's tokenizer with our tree builder, or trimmed parse5? The target is
  about 10 kB gzip for HTML and CSS together. Decided by the spike.
- **The style binding's cost**: is a literal list of 15 to 40 properties per element fast enough on a
  newsletter of 2,000 elements, and small enough as generated components? If not: properties grouped by
  how often email sets them, or a smaller list per tag.
- **`data:` images**: the size bound, and whether to keep them at all.
- **`media: 'narrow'`**: is 600 px the right width, and should the option be a number?
- **Outlook's conditional comments**: are there emails whose content is only inside `<!--[if mso]>`?
  The corpus will tell.

## Later

- **MIME**: reading a message into its bodies and attachments, through
  [postal-mime](https://github.com/postalsys/postal-mime) (browser and Node, limits on nesting, headers
  and parts, careful charset handling), not a parser of our own. It joins a message's HTML parts into one
  string, which is safe only for content that was all encrypted or all not: see PGP.
- **PGP/MIME**: the app decrypts and verifies (openpgp.js in a `data-sn-call` action); this library would
  check the outer structure (`multipart/encrypted` with its two parts, nothing else), read the decrypted
  payload, and mark which bodies were encrypted or signed. Verifying a `multipart/signed` part needs its
  raw bytes, which postal-mime does not return: to be asked upstream.
- **Quoted replies in HTML email** (`blockquote type=cite`, Gmail's and Outlook's markers), into `part`.
- **A proxy for remote images** (`images: 'proxy'` with a URL template).
- **Background images**, through a checked `background` attribute on tables and cells.
