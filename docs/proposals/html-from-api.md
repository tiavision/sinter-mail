# An email's HTML from an API, faster: measured against Caley's iframe

Status: done. The path this is about: the email arrives in the browser as HTML (from an API, or decrypted in
the page: a PGP mail's tree cannot come from the server), `mail.parse` runs there, and `<mail-body>` builds its
elements. The comparison is what [Caley](https://git.tia.sh/tia/Caley) did before it moved to sinter-mail:
DOMPurify with a hook and a `cleanStyle` over each style attribute, then a sandboxed `srcdoc` iframe.

In short: sinter-mail 0.21 was already faster than the iframe on every email. With `<mail-warm>` on the page the
first email of a session now shows 6 to 34 ms sooner (16 to 45 ms after its last byte instead of 22 to 79), a
later large one 6 to 8 ms sooner, and `mail.parse` itself takes 20 to 40% less. Against the isolated frame Caley
used for decrypted mail, that is 2.3 to 3.3 times as fast for a first email and 2 to 4 times for a later one.

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

Milliseconds from the message's last byte to the email painted; `first / later`. One run of every variant by
turns; a small email's time is one or two display frames, so its last digit means little.

| | sinter-mail 0.21 | Caley, iframe | Caley, isolated iframe (decrypted mail) |
| --- | --- | --- | --- |
| reply, 3 kB | 22 / 13 | 29 / 17 | 41 / 37 |
| receipt, 20 kB | 26 / 12 | 35 / 35 | 47 / 40 |
| Outlook thread, 39 kB | 38 / 18 | 35 / 35 | 54 / 40 |
| newsletter, 185 kB | 66 / 29 | 107 / 73 | 106 / 95 |
| digest, 285 kB | 79 / 54 | 120 / 121 | 138 / 118 |

Of it, script (for the frames: script, and the frame's HTML parsing after the `+`):

| | sinter-mail 0.21 | Caley, iframe | Caley, isolated iframe |
| --- | --- | --- | --- |
| reply | 15 / 3 | 12 + 1 / 10 + 1 | 21 / 13 |
| receipt | 18 / 6 | 16 + 2 / 16 + 3 | 21 + 2 / 14 + 1 |
| Outlook thread | 27 / 7 | 21 + 2 / 21 + 2 | 29 + 1 / 17 + 1 |
| newsletter | 44 / 15 | 58 + 18 / 43 + 15 | 52 + 16 / 44 + 14 |
| digest | 47 / 27 | 70 + 13 / 86 + 10 | 81 + 12 / 61 + 12 |

Page JavaScript, gzip: 48.9 kB with the parser, 26.0 kB for Caley's page with DOMPurify.

sinter-mail was ahead on every email already, but for the first Outlook thread. Why the iframe loses:

- **DOMPurify does not get faster.** Its time is calls into the DOM (a walk over a parsed document, an
  attribute at a time, then a serialization), not JavaScript that V8 could optimise: 10 to 86 ms of script for a
  later email, where `mail.parse` and the builder took 3 to 27.
- **The HTML is parsed twice**, by DOMPurify's document and by the frame: 10 to 18 ms more for the large emails.
- **An isolated frame is another process.** Its document is parsed, laid out and painted there, behind two
  hops between processes, and little in it is warm for the next message: 37 to 118 ms whatever came before.

And what was left to win for sinter-mail:

- **The first email.** 22 to 79 ms against 12 to 54 for a later one. Script is two to five times its later
  cost: V8 compiles a function at its first call and runs it in its interpreter until it has seen enough of it,
  and a parse runs most of the parser. Opening the same newsletter eight times in a new page, the script of each:
  62, 37, 28, 18, 18, 19, 17, 17 ms.
- **Large emails**, where script is half of a later email's time (the rest is the browser's style, layout and
  paint of the same elements, which an iframe pays too).
- The small emails are at the floor: a display frame or two, of which 5 ms is work.

## Where the time goes

A later (warm) newsletter in 0.21: 15 ms of script, of which `mail.parse` about 9 and the builder with its DOM
calls about 4; then 2.5 ms style, 5 ms layout, 4 ms paint. `mail.parse` alone (Node, warm): 8.5 ms, of it the HTML
parser 2.1 (tokenizer 0.9, tree construction 1.1, the copy to the raw tree the rest), the cascade 3.0, the
sanitized tree 3.4, and garbage collection about 13% of the whole.

The profile is flat, warm and cold: no function has more than a few percent. The same code is three to four
times slower the first time, everywhere at once. So there were two things to do: have the code run before the
first email, and take allocations and passes out of all of it.

## What changed

- **`<mail-warm>` warms the parser up.** It had one sample, a small table of identical cells, parsed four times:
  a round ran each style's code once, and thirty rounds warmed no better than four. It now parses emails written
  as mail is written (`sinter/warm.ts`: a builder's newsletter with a style sheet, `@media` and a dark scheme, an
  Outlook thread in Word's HTML, a Gmail reply with quoted history and inline-styled rows), their values varying
  with the element so that a round has a hundred or more distinct styles; 24 of them, one per idle period, the
  first three small. They are parsed outside `mail.parse`'s cache. About 150 ms of idle time in all.
- **The HTML parser builds the raw tree as it goes** instead of a tree of its own that was then copied; a tag's
  and an attribute's name are slices of the input (lowercased only when they have an uppercase letter); no tuple,
  closure or token object per tag. `parseHTML` 20 to 40% faster.
- **The entity table is unpacked when needed.** All 2,231 names were unpacked into a map at every page load,
  2.5 ms of it; the legacy names and 25 more that emails write are ready at load, the rest on the first reference
  that is not among them (none in the corpus).
- **The cascade allocates nothing per element that it can share**: no closures made per element, no set of its
  classes, no key string for the styles it shares (they are found by the inline text, the hints, then the matched
  rules), rules looked up by id, class and tag without building keys, the of-type counts only when a selector
  asks. 25 to 50% faster.
- **The sanitized tree in one pass less, and two searches fewer**: Outlook's quote markers are looked for only in
  an email that has one (they were searched for in every child list, three levels deep), in-email link targets
  collected only when a `#` link exists, nodes frozen as they are made.
- **The builder** goes through the attributes an element has, not the dozen its tag may have, and sets a lone
  text with one call.
- **sinter**: `<mail-warm>` warned SN543 ("filled at mount") on every page that used it; a component whose root
  is `hidden` no longer does.

Found on the way and fixed, each in 0.21: an email with a tag, a property or an attribute value named as
something every object has (`<constructor>`, `style="constructor: inherit"`, `<img align=constructor>`) made
`mail.parse` throw or put a function in a style, and so did a table nested exactly at the depth bound
(`<table><td></tbody>` 252 elements deep).

## Where it stands

`mail.parse` alone, Node, median ms (`bench/parse.mjs`): a later parse, and the first of a new process.

| | later: 0.21 | now | first: 0.21 | now |
| --- | --- | --- | --- | --- |
| reply, 3 kB | 0.24 | 0.19 | 7.5 | 6.6 |
| receipt, 20 kB | 1.49 | 1.11 | 15.5 | 13.0 |
| Outlook thread, 39 kB | 2.67 | 1.87 | 20.6 | 17.5 |
| newsletter, 185 kB | 8.50 | 5.01 | 38.3 | 30.5 |
| digest, 285 kB | 11.75 | 7.32 | 43.1 | 32.9 |

The trees are the same ones: every email of both corpora under four option sets and the awkward inputs of
`bench/parse.mjs`, compared as JSON, and 200,000 random documents through the HTML parser, apart from the
emails that used to throw.

In Chromium, from the message's last byte to the email painted, `first / later` (`bench/html.mjs`):

| | 0.21 | now | now, with `<mail-warm>` | Caley, iframe | Caley, isolated iframe |
| --- | --- | --- | --- | --- | --- |
| reply, 3 kB | 22 / 13 | 17 / 9 | 16 / 14 | 29 / 17 | 41 / 37 |
| receipt, 20 kB | 26 / 12 | 31 / 11 | 20 / 13 | 35 / 35 | 47 / 40 |
| Outlook thread, 39 kB | 38 / 18 | 38 / 17 | 22 / 16 | 35 / 35 | 54 / 40 |
| newsletter, 185 kB | 66 / 29 | 65 / 23 | 32 / 24 | 107 / 73 | 106 / 95 |
| digest, 285 kB | 79 / 54 | 82 / 46 | 45 / 41 to 54 | 120 / 121 | 138 / 118 |

Of it, script:

| | 0.21 | now | now, with `<mail-warm>` |
| --- | --- | --- | --- |
| reply | 15 / 3 | 11 / 3 | 2 / 3 |
| receipt | 18 / 6 | 22 / 5 | 6 / 5 |
| Outlook thread | 27 / 7 | 25 / 7 | 6 / 5 |
| newsletter | 44 / 15 | 44 / 13 | 18 / 12 |
| digest | 47 / 27 | 48 / 17 | 19 / 16 to 21 |

How to read it:

- **A first email is as slow as before without `<mail-warm>`.** The parser's and the cascade's changes do not
  show there: code that runs for the first time is slow whatever it does, and the differences between the first
  two columns are run-to-run noise. With `<mail-warm>` the first email's script is at a later one's, or within
  a few milliseconds of it; the rest of the difference is the browser's first layout of the kind (about 5 ms,
  which an iframe pays too; see below).
- **A later email**: script 15 to 13 ms for the newsletter and 27 to 17 for the digest; the small emails were
  at the floor. The columns with and without `<mail-warm>` are the same code by then, and differ by noise (a
  garbage collection that falls in the measured window or not: the digest's later open measured 41 and 54 ms
  in two runs).
- **Against Caley's isolated frame** (decrypted mail): 2.3 to 3.3 times as fast for a first email with
  `<mail-warm>` (16 to 45 ms against 41 to 138), 2 to 4 times for a later one (9 to 54 ms against 37 to 118).

The same newsletter opened several times in a row in a new page, script per open: 62, 37, 28, 18, 18 … in 0.21;
38, 23, 15, 13, 11, 10 … now; 20, 13, 11, 10 … with `<mail-warm>`. (A first open varies more between runs than
anything else here: 44 to 62 ms of script for the same code.)

What it costs: page JavaScript 48.9 to 50.8 kB gzip (the parser 16.6 to 17.5 kB, the cascade 18.3 to 19.1), and
55.4 kB on a page with `<mail-warm>` (its samples are 4.5 kB).

## Tried, and left out

- **More rounds of the old warm-up sample.** One small table of identical cells, parsed 30 times instead of 4:
  no faster a first email in Chromium (and the newsletter's first parse in Node 24 ms, where the new samples
  leave 13 of 39). Each round ran each style's code once; the variety of a real email is what warms the parser.
- **More than 24 samples.** 36 are no better than 24; 12 leave the newsletter's first parse at twice a later
  one's.
- **Warming the browser's layout.** The first email's layout costs about 6 ms more than a later one's. Laying
  out a hidden sample first (a table of the same shapes, or text in the common fonts) changed nothing, and an
  iframe pays the same, so it is not the library's to fix.
- **Another way to write the elements.** The same tree put in the page four ways (digest, 2,575 elements; script,
  style, layout in ms): the builder 5.6 / 2.9 / 10.3; `createElement` with `setProperty` per property 8.0 / 3.4 /
  10.5; with one `cssText` per element 7.7 / 3.2 / 10.5; as markup through `innerHTML` (which the library never
  does) 13.5 / 3.2 / 10.9. The builder's copies of styled elements are the fastest for script and for style.
- **`compileHints` alone**: the first newsletter's script 47 to 39 ms. It removes the compiling, not the slow
  first runs; `<mail-warm>` removes both, and with it the hints add nothing measurable.
- **Character loops for the tree builder's whitespace tests** (in place of two regular expressions): slower,
  `parseHTML` 1.25 to 1.63 ms on the newsletter.
- **The legacy hints as a lookup tree of their own** in the cascade's shared styles: 0 to 4%, within noise.

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
node --experimental-strip-types bench/html.mjs                    # every email and variant, about 15 minutes
node --experimental-strip-types bench/html.mjs 5 newsletter mail,warm
BASE=../other-checkout node --experimental-strip-types bench/html.mjs 9 newsletter mail,base
OPENS=6 node --experimental-strip-types bench/html.mjs 5 newsletter mail,warm    # the same email six times in a row
node --experimental-strip-types bench/profile.mjs newsletter first               # V8's profile of one message
node bench/parse.mjs ../other-checkout    # mail.parse in Node against another checkout: the same trees, warm, cold
```

They need sinter built beside this package (`../sinter`, `npm run build`).
