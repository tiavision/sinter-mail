# Rendering faster: two ideas, measured

Status: prototype on branch `ccr-b2114177-bx52ep`, measured against sinter `main` (812bda8, built from
source, not the 0.19.0 release). Chromium (Playwright's headless build), the 2,012-element generated
newsletter of `test/app.ts`, served as a tree from the API. Medians of 15 interleaved runs. Times are
from the API's answer.

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
- `<mail-body>` has a script. After the first frame has painted (`requestAnimationFrame`, then a
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
- **A static page ships JavaScript.** A component script makes `<mail-body>` ship code, so
  `static.test.ts` fails with SN322. `components.test.ts` fails too, because it asserts the exact shape
  of the generated loops. A version to keep would put the progressive path in its own component (or
  make it the runtime's job, below), so that `<mail-body>` stays foldable with no JavaScript.
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

## Running the benches

`node --experimental-strip-types bench/prog.mjs [runs] [elements] [head] gen '<variants>'` (variants:
`plain:` or `prog:step=N`, comma-separated). `bench/trace.mjs prog|plain` prints the main thread's tasks.
`bench/micro.mjs` compares `setProperty` with `cssText`. `bench/count.mjs` counts the style calls. They
need sinter built beside this package (`../sinter`, `npm run build`).
