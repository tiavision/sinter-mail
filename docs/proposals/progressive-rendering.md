# Rendering faster: two ideas, measured

Status: built: `<mail-body>` renders a body that `mail.progressive` numbered progressively, in steps ([the
guide](../mail.md#long-messages-mailprogressivebody)), on sinter's #77 and #78. Measured against sinter `main` built
from source, not a release. Chromium (Playwright's headless build), the 2,012-element generated newsletter of
`test/app.ts`, served as a tree from the API; medians of 11 to 15 interleaved runs; times from the API's answer. The
sections below are in the order the work went: the first version rendered in two phases, as its own component.

## Where the time goes

A trace of today's render: about 15 to 20 ms after the answer before rendering starts (the resource and
its JSON), then **one 44 ms task of script**, then 4 ms style, 7 ms layout and 3 ms paint. Script is
where the time is.

## Idea 2, batched style writes: not worth it

The idea: write each element's styles as one declaration block (`style.cssText`), not a `setProperty`
per property, "30 to 80k calls down to 2k".

- **The calls are fewer than assumed.** The render makes 8,448 `setProperty` calls for 1,743 styled
  elements (4.8 each). sinter's e56b2a2 (a first write skips unset entries) already removed the rest.
- **A call is cheap.** 2,000 fresh elements: 5 properties take 1.9 ms with `setProperty` and 2.2 ms
  with `cssText`. 10 properties take 3.9 and 4.7 ms. One block is slower, not faster: Blink parses it
  whole, and the string has to be built first. All the render's style writes are about 2 to 3 ms of 70.
  (A sampling profile showed 10 ms in the style writer. That was profiler overhead.)
- **Prototyped and measured anyway** (`bench/sinter-batched-style.diff`, in sinter's `W.g`): 67.2 ms
  without, 68.9 ms with, which is noise. The output was identical.
- CSP was never the obstacle: `style.cssText` is CSSOM, which `style-src 'self'` allows, as it allows
  `setProperty`. The real carve-out would be injection. A value that `setProperty` rejects alone
  (`red; position: fixed`, `red !important`, an unclosed `(` or quote, a comment) changes the block
  around it. The prototype has a check for that (`declSafe`), which is cost the batching cannot pay
  back.

Dropped. Caching a string per shared style object would not help either: the browser still parses the
string for each element.

## Idea 1, rendering incrementally: worth it for long messages

The prototype changes sinter-mail only, with no change to sinter:

- `mail.progressive(body, head = 200)` numbers the nodes in document order: `n` on each node, and `z`
  on an element, the last number in its subtree. It also sets `body.head`. It is opt-in, so a tree
  without it renders as before. A `file:` email folded at build time stays whole.
- The generated components take a `limit` prop. A loop filters `n < limit` only on an element the cut
  passes through (`z >= limit`). Every other element gets the same array, and its children get the
  constant `1e9`.
- `<mail-body-progressive>` has a script (`<mail-body>` does not, and stays foldable). After the first frame has painted (`requestAnimationFrame`, then a
  task), it lifts the limit. The rows already rendered are kept: the objects are the same, and rows
  match by item.

| (ms) | first paint of the email | all rendered | longest frame gap |
| --- | --- | --- | --- |
| today | 103.4 | 72.9 | 50 |
| progressive, two phases (200 nodes, then the rest) | **49.7** | 93.1 | 50 |
| progressive, 1,000-node steps | 48.4 | 244.1 | 67 |

The final DOM is identical in every variant. In the trace, the first phase is one 10 ms task, and the
email's top paints about 42 ms sooner. The second phase is one 48 ms task, against 44 ms for the whole
email in one go.

What it costs:

- **About 20 ms more in total** (+28%): the first phase's own task, a second style and layout pass, and
  the second phase walking the cut path again.
- **The remaining block is as long as today.** The second phase still blocks input for about 48 ms.
  Splitting it does not work in this design. Every list already rendered reads `limit`, so sinter's
  dependency paths reach all of them, and each step re-evaluates and reconciles every list on the page.
  Steps start at 15 ms and climb to 87 ms, about 3× the total. That growth also comes from
  `<sn-component use>`. It passes a new props object per evaluation, and `toggle()` then force-walks the
  case's whole subtree. A shallow comparison stops the growth (`bench/sinter-shallow-props-unsafe.diff`:
  steps level at about 27 ms) but is **not correct**. sinter's `anchors.test` and `wrapper-fuzz.test`
  fail, because an in-place change under a prop reaches the case's row only through that forced walk.
- **The JSON is 12% bigger** (411 kB to 460 kB) when the API numbers the tree. Numbering in the browser
  instead is about one walk.
- **A page that uses it ships JavaScript.** The script is why the progressive path is its own component:
  `<mail-body>` has none, and a static page with it still folds with no JavaScript.
- Emails under `head` nodes are not affected. The corpus emails are all smaller than that.

## For sinter in general

The win, first content in about half the time, is not specific to email. Any long list or deep tree
rendered from one answer has it. In sinter, though, the right place is the runtime, not data:

- **A render budget in `reconcile`/`instantiate`.** Create rows until a budget is spent (rows, or about
  8 ms), then queue the rest in document order and continue in later tasks, after a paint. There is no
  limit for every list to read, so nothing already rendered is walked again. Total cost stays near
  today's, every task stays short (input is never blocked for long), and no component, prop or script
  changes. The work is a placeholder row (a node that holds its place, matched and moved like a row)
  and the cases where a placeholder's list changes, or its parent row moves or goes, before the
  placeholder is filled. That is where the effort and the risk are.
- **Tracing dependency paths through `<sn-component use>` props** would make the shallow comparison
  above correct, and would save every recursive component tree a forced re-walk on each render, with or
  without progressive rendering.

## Streaming the tree as it arrives: not now

The idea is for the API (or a parser in the browser) to stream the tree into a binding that renders while
the answer arrives, so that receiving and rendering interleave. `bench/network.mjs` measures the newsletter
gzipped, as a server sends it, under Chromium's throttling (medians of 3):

| | first byte | body transfer | page JS arrives after the body | first paint after both |
| --- | --- | --- | --- | --- |
| no throttling | 4 ms | 1 ms | 1 ms | 97 ms |
| fast 4G (9 Mbps, 85 ms RTT) | 86 ms | 9 ms | 319 ms | 84 ms |
| slow 4G (1.6 Mbps, 150 ms RTT) | 154 ms | 48 ms | 1,784 ms | 84 ms |

- **What streaming could save is the body's transfer.** The time spent rendering moves to before the
  last byte, so the win is at most the transfer time (and the server's parse, if it streams that too, about
  50 ms). The generated tree gzips from 402 kB to 5.3 kB, so its transfer is 1 to 48 ms. A real email
  compresses less (a large one perhaps 30 to 60 kB gzip, about 50 to 300 ms on slow 4G), so a large email
  on a slow network is where it would matter.
- **The answer is not on the critical path of a first visit.** It arrives long before the page's
  JavaScript. In an open app (the next message, scripts cached), the critical path is a round trip
  (85 to 150 ms), the transfer, then the render. sinter's `embed` layer removes the round trip for the
  first message, and progressive rendering (`mail.progressive`) puts the first paint about 10 ms after the answer.
- **sinter cannot render a growing tree cheaply.** A streamed tree grows at its open spine, so each chunk
  changes the root's descendants: in place (an append to `children`) or as new objects along the spine.
  Either way the recursive components above it render their subtrees again, forced. That is correct:
  a change inside a prop's value must reach the bindings that read it, and sinter's #77 keeps exactly that
  case forced. So each chunk would cost about as much as what is already rendered, which the stepped
  limit above measures (400-node steps: 264 ms in all, against 70 ms in one task). A cheap streamed tree
  needs the runtime to append rows to a list without walking what is already rendered (a stream-aware
  `data-sn-for`, or the render budget above), and the tree delivered as appends to lists (each node's
  children as their own stream). That is a new runtime primitive, not a binding.
- A flat list (search results, a message list) streams well today: an append reconciles the list (a key
  per item), and only the new rows render. That, not email, is where a streamed resource would be the
  smaller change.

Not spiked: the measurements bound the gain (the body's transfer) below what embedding and the progressive
component already give. The work is in sinter's runtime. It would be worth revisiting with a real corpus of
large emails and an app's own latency profile.

## Steps: what shipped

The two-phase render left one task of about 48 ms after the first paint (150 to 240 ms on a phone): input
waits for it. Stepping the limit cost about 3 times the total, since every list read the limit. Two designs were
spiked against sinter with #77:

- **Identity** (`bench/sinter-identity-spike.diff`): the tree grows in place and the runtime is told which
  objects changed (an index from objects to the components holding them). Steps of 3 to 10 ms, +331 B gzip on the
  core, +0.7 to 2 ms on a recursive tree's first render. It needs an API: a component script can only say that a
  top-level state field changed, so it would need `this.changed(obj)`.
- **Copies** (`bench/sinter-copy-spike.diff`, `bench/sinter-mail-copy-spike.diff`): each step is a new tree, a
  copy of the elements down to the step's end, the rest shared; rows are keyed by the nodes' numbers, so a copy
  keeps its row. In sinter (#78) a replaced item or props render down to the components whose props did not change,
  instead of everything below. No API, +44 B gzip, first renders and js-framework-benchmark unchanged.

Copies shipped. `<mail-body>` has two branches: a body that is not numbered renders as before (a static page's is
decided at build time and ships no script); a numbered one renders `body.first`, then the trees a small internal
component (`mail-steps`, the only one with a script) emits after each paint, 400 nodes further each time.

| 2,012 elements | email starts showing | longest task after it | longest frame gap | whole email in place |
| --- | --- | --- | --- | --- |
| whole, one task | ~92-108 ms | n/a (one task of ~45 ms) | 50 ms | ~67-75 ms |
| two phases (first version) | ~46-50 ms | ~48 ms | 50 ms | ~88-92 ms |
| limit in 400-node steps, #77 | ~45-47 ms | ~31 ms, growing | 33 ms | ~261-264 ms |
| **steps of copies, #78 (shipped)** | **~48-50 ms** | **~10-20 ms, flat** | **17-33 ms** | ~180-195 ms (a frame between steps) |

The final DOM equals a whole render in every variant. What it changes in sinter: a computed list's kept rows,
which rendered everything below them on every evaluation in case an item changed in place unseen, now do so only
when a change inside a value the list reads reaches it (sinter's changelog).

## Running the benches

`node --experimental-strip-types bench/prog.mjs [runs] [elements] [head] gen '<variants>'` (variants:
`plain:` or `prog:step=N`, comma-separated). `bench/trace.mjs prog|plain` prints the main thread's tasks.
`bench/grow.mjs` grows a tree in place (the identity spike). `bench/network.mjs [elements] [runs]` splits the wait under throttling. `bench/micro.mjs` compares `setProperty` with `cssText`. `bench/count.mjs` counts the style calls. They
need sinter built beside this package (`../sinter`, `npm run build`).
