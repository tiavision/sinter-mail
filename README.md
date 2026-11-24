# @tiavision/sinter-mail

Show email in your [sinter](https://github.com/tiaforge/sinter) app, without an iframe.

Hand it an email's HTML (or plain text) and it renders as a normal part of your page: it scrolls, selects,
searches and prints with the rest, and picks up your fonts where the email sets none. Nothing in an email
runs, loads from the network without your say-so, or reaches outside its box.

```html
<sn-resource name="msg" src="/api/messages/{$url.id}"></sn-resource>
<article data-sn-let="{ body: msg.html ? mail.parse(msg.html, { images: 'proxy', proxy: '/img?url={url}' }) : mail.plain(msg.text) }">
  <mail-body data-sn-with="{ body }"></mail-body>
</article>
```

## Why

Webmail UIs usually put a message in an iframe, or sanitize its HTML and inject it with `innerHTML`.
sinter never builds HTML from data, so this library takes a third route: `mail.parse` turns the email into a
tree, and generated components render each element, with every attribute and style checked.

- **Safe by construction.** No script, handler, `javascript:` link, SVG, form or iframe can exist in the tree.
  The page's CSP can stay strict (`script-src 'self'`, Trusted Types).
- **Private images.** Remote images are left out by default, so tracking pixels never fire. Turn them on, or
  route them through your own proxy so senders never see your readers' addresses.
- **Looks like the sender's email.** The parser follows the HTML standard, and the email's styles
  (`<style>` rules, inline styles, legacy attributes like `bgcolor` and `<font>`) are resolved the way a
  browser's cascade would.
- **Fast where it counts.** An email in a file is folded into plain HTML at build time, with no JavaScript.
  An email from an API is rendered by a script builder. Parse in the browser, lazily, or on your server.
- **Plain text too.** `mail.plain` handles `text/plain` bodies: links, quotes, signatures and
  `format=flowed`.
- **Whole messages and OpenPGP.** `mail.mime` reads a raw message into its bodies (never joined), attachments and
  inline images, and lists what your app must decrypt or verify; it checks the structure strictly, reads the
  decrypted payload, applies protected headers and labels each part. Keys and crypto stay in your app.

## Install

```sh
npm install @tiavision/sinter-mail
```

Needs sinter 0.22.0 or later (until it is released, sinter's main).

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

## Usage

**HTML email**

```html
<article data-sn-let="{ body: mail.parse(msg.html) }">
  <mail-body data-sn-with="{ body }"></mail-body>
</article>
```

**Images through your proxy**

```js
mail.parse(html, { images: 'proxy', proxy: '/img?url={url}' })
```

**Inline (`cid:`) images**

```js
mail.parse(html, { cid: '/api/messages/42/parts?cid={cid}' })
```

**Plain text**

```js
mail.plain(text, { flowed: true })
```

**An email from a file, folded at build time** (`src="file:./welcome.html"`): the page ships it as plain
HTML, with no JavaScript. See [the guide](docs/mail.md#three-places-one-function).

**Whole messages and OpenPGP**

```html
<article data-sn-let="{ msg: raw ? mail.mime(raw, results) : null }">
  <template data-sn-if="msg">
    <template data-sn-for="p in msg.parts">
      <template data-sn-if="p.type === 'html'">
        <mail-body data-sn-with="{ body: mail.parse(p.html, { legacyDisplay: p.legacyDisplay, encrypted: p.protection.encrypted }) }"></mail-body>
      </template>
      <template data-sn-else data-sn-if="p.type === 'text'">
        <mail-body data-sn-with="{ body: mail.plain(p.text, { flowed: p.flowed, delsp: p.delsp }) }"></mail-body>
      </template>
    </template>
  </template>
</article>
```

`raw` is the message's bytes (a `Uint8Array`) and `results` the results of its steps, in state. An action runs
`msg.steps` with your OpenPGP library (decrypt with integrity required, verify returning only the addresses you
trust), stores each result by step id, and the message is read again with them; `msg.summary` says what to badge.
Attachments and inline images come out through `mail.bytes(raw, ref, results)`, an image only when
`mail.imageType` knows its bytes. On lock or logout, `mail.mime.clear()` drops the messages it keeps and the
plaintexts they hold. See [whole messages](docs/mail.md#whole-messages-mailmimebytes-options) and
[encrypted and signed mail](docs/mail.md#encrypted-and-signed-mail).

**Previews and search snippets**

```js
mail.text(body)   // the text, blocks separated by newlines
mail.links(body)  // every link with its text
```

An email from an API renders through a script builder that is about 7 times faster than templates, and never
writes HTML; a use with slot fills, or `templates: true`, renders through templates. The build ships only the
path a page uses. See [how `<mail-body>` renders](docs/mail.md#how-mail-body-renders).

Links and images can be restyled by filling the `link` and `image` slots of `<mail-body>`. `<mail-width>` says
when the reader is narrow enough for the email's phone layout, so a newsletter is not a 600px page scrolled
sideways on a phone.
An app whose CSS resets the browser's defaults imports `@tiavision/sinter-mail/mail.css`, which gives emails back
what they count on, and a light canvas in dark mode to an email written for a white page.

## Documentation

- **[The guide](docs/mail.md)**: all options, what is kept and dropped, styling, proxies, slots, whole messages and OpenPGP, CSP, and the security guarantees.
- **[Design notes](docs/proposals/sinter-mail.md)**: why it is built the way it is; [MIME and OpenPGP](docs/proposals/sinter-mail-mime.md).
- **[Contributing](CONTRIBUTING.md)**: layout, tests and the release process.

## Limits

Only the email's own styles apply (no `:hover`, animation or web fonts), `@media` is decided once at parse
time (but for the colour scheme: colours set by `prefers-color-scheme: dark` rules follow the page's), the library is tested in Chromium so far, and `mail.mime` reads OpenPGP but not yet S/MIME. [The guide](docs/mail.md#limits) has the full list.

## License

MIT
