# An email's HTML from an API, faster: measured against Caley's iframe

Status: in progress. The bench, the baseline and the warm-up are in; the parser's and the cascade's changes and the
final numbers are to come. The path this is about: the email
arrives in the browser as HTML (from an API, or decrypted in the page: a PGP mail's tree cannot come from the
server), `mail.parse` runs there, and `<mail-body>` builds its elements. The comparison is what
[Caley](https://git.tia.sh/tia/Caley) did before it moved to sinter-mail: DOMPurify with a hook and a
`cleanStyle` over each style attribute, then a sandboxed `srcdoc` iframe.

## How it is measured

`bench/html.mjs` builds a reader page per variant (a button opens the next message, an action fetches it, as
Caley's `<sn-resource call="mail.body(open)">` does) and reads a Chromium trace of each message:

- **wall**: from the message's last byte to the end of the main-thread frame that paints the whole email;
- **cpu**: the main threads' busy time in between, in every renderer process, split into script, HTML
  parsing, style, layout and paint.

Variants:

- `mail`: the action answers the HTML, `mail.parse` in a let, `<mail-body>`; `warm`: with `<mail-warm>` on the
  page.
- `frame`: Caley's sanitizer (`bench/caley/mail-html.ts`, as it was at its commit `bb53e0f^`) in the action, then
  its `<mail-frame>` with `sandbox="allow-popups allow-same-origin allow-popups-to-escape-sandbox"`.
- `isolated`: the same without `allow-same-origin`: Caley's frame for **decrypted** mail. Chrome gives such a
  frame an opaque origin and a renderer process of its own.

Two moments: the **first** message opened in a page that is loaded and idle (the code has never run), and a
**later** one, after ten others (the code is warm, as in a session).

The emails (`bench/corpus/`, written by `corpus/make.mjs`): a Gmail reply quoting three messages (3 kB, 81
elements), an order confirmation and a newsletter as MJML writes them (20 kB, 178 elements; 185 kB, 1,353
elements), a thread of eight messages as Outlook for Windows writes them (39 kB, 827 elements), and a digest of
160 items with every style inline (285 kB, 2,575 elements).

What the bench had to get right, each found by a number that did not add up:

- **Chrome, not the headless shell.** Playwright's default headless shell keeps a sandboxed frame in the page's
  process; Chrome (`channel: 'chromium'`) does not, and that is what a reader's browser does.
- **Each message is another text.** The same markup with other words: otherwise the parse is answered from its
  cache, the frame keeps the document it already shows, and the browser lays out words it has shaped before
  several times faster than new ones.
- **Images arrive later and are not cached**, as over a network. On localhost they arrived before the first
  paint of the first message only, which then paid two layouts.
- **Tracing, not timers in the page.** A frame in another process cannot be timed from the page, and
  `requestAnimationFrame` adds up to a frame of waiting.

Chromium 158 (Playwright 1.63), a 4-core Linux container, medians of 7.

## Where it stood

Milliseconds from the message's last byte to the email painted; `first / later`.

| | sinter-mail 0.21 | Caley, iframe | Caley, isolated iframe (decrypted mail) |
| --- | --- | --- | --- |
| reply, 3 kB | 18 / 17 | 29 / 17 | 34 / 37 |
| receipt, 20 kB | 27 / 17 | 33 / 33 | 46 / 36 |
| Outlook thread, 39 kB | 37 / 21 | 38 / 34 | 45 / 40 |
| newsletter, 185 kB | 75 / 27 | 98 / 82 | 105 / 105 |
| digest, 285 kB | 81 / 50 | 115 / 94 | 120 / 119 |

Page JavaScript, gzip: 48.9 kB with the parser, 26.0 kB for Caley's page with DOMPurify.

sinter-mail was ahead on every email already. Why the iframe loses:

- **DOMPurify does not get faster.** Its time is calls into the DOM (a walk over a parsed document, an
  attribute at a time, then a serialization), not JavaScript that V8 could optimise: 11 to 56 ms of script for a
  later email, where `mail.parse` and the builder take 3 to 23.
- **The HTML is parsed twice**, by DOMPurify's document and by the frame: 9 to 16 ms more for the large emails.
- **An isolated frame is another process.** Its document is parsed, laid out and painted there, behind two
  hops between processes, and nothing in it is warm for the next message: 36 to 119 ms whatever came before.

And what was left to win for sinter-mail:

- **The first email.** 27 to 81 ms against 17 to 50 for a later one. Script is three to four times its later
  cost: V8 compiles a function at its first call and runs it in its interpreter until it has seen enough of it,
  and a parse runs most of the parser. Opening the same newsletter six times in a new page, the script of each:
  51, 36, 21, 17, 16, 13 ms.
- **Large emails**, where script is half of a later email's time (the rest is the browser's style, layout and
  paint of the same elements, which an iframe pays too).
- The small emails are at the floor: about 17 ms is one display frame, of which 5 ms is work.

## Where the time goes

A later (warm) newsletter: 14 ms of script, of which `mail.parse` about 9 and the builder with its DOM calls
about 4; then 2.5 ms style, 5 ms layout, 4 ms paint. `mail.parse` alone (Node, warm): 9.5 ms, of it the HTML
parser 2.4 (tokenizer 0.9, tree construction 1.1, the copy to the raw tree 0.2 to 0.6), the cascade 3.7, the
sanitized tree 2 to 3.5, and garbage collection about 13% of the whole.

The profile is flat, warm and cold: no function has more than a few percent. The same code is three to four
times slower the first time, everywhere at once.

## What changed

- **`<mail-warm>`** parses sample emails written as mail is written (`sinter/warm.ts`: a builder's newsletter, an
  Outlook thread, a Gmail reply, their values varying with the element), 24 of them, one per idle period. The parse
  alone, first of a fresh process (Node): newsletter 39 to 13 ms, digest 44 to 16, Outlook thread 22 to 5, receipt
  16 to 2.5, reply 7 to 0.8. About 150 ms of idle time, and 3.7 kB gzip more on a page that uses it.
- To come: the HTML parser and the cascade.

## Where it stands

To come, with the final run.

## Tried, and left out

- **More rounds of the old warm-up sample.** One small table of identical cells, parsed 30 times instead of 4:
  no faster a first email in Chromium (and 24 ms instead of 13 for the parse in Node). Each round ran each
  style's code once; the variety of a real email is what warms the parser.
- **Warming the browser's layout.** The first email's layout costs about 6 ms more than a later one's. Laying
  out a hidden sample first (a table of the same shapes, or text in the common fonts) changed nothing, and an
  iframe pays the same, so it is not the library's to fix.
- **Another way to write the elements.** The same tree put in the page four ways (digest, 2,575 elements; script,
  style, layout in ms): the builder 5.6 / 2.9 / 10.3; `createElement` with `setProperty` per property 8.0 / 3.4 /
  10.5; with one `cssText` per element 7.7 / 3.2 / 10.5; as markup through `innerHTML` (which the library never
  does) 13.5 / 3.2 / 10.9. The builder's copies of styled elements are the fastest for script and for style.
- **`compileHints` alone**: the first newsletter's script 47 to 39 ms. It removes the compiling, not the slow
  first runs; `<mail-warm>` removes both, and with it the hints add nothing measurable.

## Not done

- **Parsing before the click.** `mail.parse` keeps its trees by source, so an app that has the HTML before the
  reader opens (a prefetch on hover, the next unread message) can call it then and the click finds the tree. That
  is the app's to decide; the library needs nothing for it.
- **A first screen first.** The builder could put the first few hundred elements in the page, let them paint and
  add the rest. On the digest the email would start showing about 25 ms sooner; a table's columns move when its
  later rows arrive, and the steps this library had were removed because the whole render became as fast as
  their first step. Worth another look only for emails of several thousand elements.
- **A worker.** The parse off the main thread would not show the email sooner (the tree has to be copied back),
  only keep the page responsive during a large parse, about 10 ms warm.

## Running it

```sh
node --experimental-strip-types bench/html.mjs                    # every email and variant, about 10 minutes
node --experimental-strip-types bench/html.mjs 5 newsletter mail,warm
BASE=../other-checkout node --experimental-strip-types bench/html.mjs 9 newsletter mail,base
OPENS=6 node --experimental-strip-types bench/html.mjs 5 newsletter mail,warm    # the same email six times in a row
node --experimental-strip-types bench/profile.mjs newsletter first               # V8's profile of one message
```

They need sinter built beside this package (`../sinter`, `npm run build`).
