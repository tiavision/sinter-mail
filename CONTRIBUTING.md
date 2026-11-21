# Contributing

Notes for working on `@tiavision/sinter-mail`. For using it, see the [README](README.md) and [docs/mail.md](docs/mail.md).

## Status

Version 0.1. It needs sinter 0.20.0 or later, the first release with the changes made for this library
(tiaforge/sinter#76, #77 and #78); `sinter check` says so (SN537) when an app has an older one.

## Releasing

From GitHub's UI: Actions → Release → Run workflow (on `main`) → the version. The [Release
workflow](.github/workflows/release.yml) sets package.json to it and commits on a temporary branch, checks
that the package builds against a sinter from npm, runs CI on that commit, and only then tags it `v<version>`
and publishes to npm with a provenance attestation; then it moves `main` to the release commit, makes the
GitHub release and deletes the branch. A run that fails before the tag leaves nothing to clean up. A pre-release
(`0.2.0-rc.1`) goes out under the `next` dist-tag. Publishing a GitHub release for an existing tag
`v<the version in package.json>` runs the same checks and publish.

Publishing needs, once:

- Before the first release: the `release` environment (Settings → Environments) with the secret `NPM_TOKEN`, a
  granular npm token that may publish under `@tiavision`. Trusted publishing can only be set up for a package
  that exists, so the first publish uses it.
- After it: `@tiavision/sinter-mail` → Settings → Trusted publishing → GitHub Actions: `tiavision/sinter-mail`,
  workflow `release.yml`, environment `release`, allowed to publish (the workflow runs `npm publish`; a
  publisher that may only stage is refused, with a 404). Then delete `NPM_TOKEN` and revoke the token: later
  releases need no secret.

## The package

```
package.json              "sinter": "./sinter", exports ".", "./parser" (the lazy part)
sinter/
  components/
    mail-body.html        public: one body, and the slots an app fills (`link`, `image`)
    mail-width.html       public: the `media` that fits the reader's width, as an event (mail-width.ts beside it)
  mail.css                optional, exported: the browser defaults emails count on, .mail-light, .mail-scroll
    internal/             generated from tags.ts: one component per tag, the dispatch, the table, the
                          steps of a progressive render (mail-steps.ts beside it)
  sinter.types.ts         the tree's types: what apps and the components name
  tags.ts                 the tag table: tags, their attributes, the properties each binds, what is dropped
  parse.ts                mail.parse: options, the tree from the raw document and the resolved styles
  engine.ts               what mail.parse runs, behind `@tiavision/sinter-mail/parser`: parser and cascade
  parser/                 the HTML parser: the standard's tokenizer and tree construction; entities.ts generated
  css/                    the cascade: tokenizer, selectors, media, values, legacy hints
  raw.ts                  the raw tree between the parser and the cascade
  plain.ts, autolink.ts   mail.plain, with GFM's autolinks
  tree.ts                 mail.text, mail.links, mail.progressive
  sinter.helpers.ts       the helpers, re-exported by the entry
  index.ts                the entry
scripts/
  build-components.mjs    writes sinter/components/internal/ from tags.ts; --check
  build-entities.mjs      writes sinter/parser/entities.ts; --check
fixtures/                 pages for `sinter check`, and trees as JSON
test/                     the tests (vitest), test/corpus/ the emails they read
docs/                     the guide and the proposals
```

### Why it is built this way

- **The email is a tree, rendered by templates.** sinter never creates HTML from data, so an email cannot
  be `innerHTML`. `mail.parse` builds a tree, and each element of it is rendered by a generated component
  whose root is that tag: its attributes and styles are bindings with literal names, which sinter checks
  at build time and sets with its checked writers at runtime.
- **The parser is the HTML standard's.** The tree must be the one the browser would build from the same
  HTML; otherwise a page built at build time would be reparsed into another tree, and an email would look
  different from what its sender tested. `test/parser.test.ts` compares it with parse5 on targeted cases and
  thousands of random documents.
- **Styles are resolved, not shipped.** A stylesheet from data would be a sink sinter does not have. The
  cascade runs at parse time instead and every element carries its own declarations. Email is where that
  costs least: email clients already drop most of what this drops.
- **One table for every list.** `sinter/tags.ts` is the only place that says what an email may contain;
  the parser's allowlist, the tree's types and the components come from it, and
  `test/components.test.ts` fails when they disagree.
- **The table is one component.** The HTML parser moves a component's tag written inside a `<table>` out
  of it, so a table's caption, columns, sections, rows and cells are literal in `mail-table`; cell content
  goes through `mail-node` as everywhere else.
- **No whitespace between tags** in the generated components: whitespace in a component is text in the
  page, once per row, and would show in tables and inline content.
- **Pure helpers.** `mail.parse`, `mail.plain`, `mail.text` and `mail.links` use only the language's
  globals and `URL`, and no module keeps state between calls, so sinter runs them at build time over a
  `file:` email. `mail.parse` keeps its trees with sinter's `memo()`; its options are normalized to
  primitives first, so equal policies share a tree.
- **The parser is behind its own specifier.** `parse.ts` imports the parser and the cascade as
  `@tiavision/sinter-mail/parser`, so an app that lists the package in `sinter({ lazy })` loads them on
  demand; `plain.ts` and `tree.ts` import neither and stay ordinary helpers.

## Changing it

- **A tag:** add it to `Tag` in `sinter/sinter.types.ts` and to `TAGS` in `sinter/tags.ts` (its attributes
  and the property groups it binds), then `npm run build:components`. A tag that only makes sense inside a
  table is `inTable` and goes into the table component's structure (`scripts/build-components.mjs`).
- **An attribute:** add it to `Attrs`, to the tag in `TAGS`, and to `attribute()` in `sinter/parse.ts`, which
  checks its value.
- **A property:** add it to `Property` and to a group in `sinter/tags.ts`, give it a grammar in
  `sinter/css/values.ts`, then `npm run build:components`. Never one that positions, loads or escapes the
  box (docs/mail.md, Security).
- **The entity table:** `npm run build:entities` after updating `character-entities`.

## Checking and testing

```sh
npm ci
npx sinter check          # the fixture pages: compiled, type-checked, the library's rules
npm run typecheck
npm test                  # vitest: 200 tests, Chromium included
```

| Test | What it covers |
| --- | --- |
| `test/parser.test.ts` | the parser against parse5: targeted cases, seeded random documents, the depth bound, hostile timings, the entity table up to date, purity |
| `test/css.test.ts` | tokenizer, values and shorthands, selectors and specificity, media, the cascade's order, legacy hints, hostile stylesheets |
| `test/css.browser.test.ts` | the cascade against Chromium's computed styles on email-like documents, at both widths |
| `test/parse.test.ts` | mail.parse: what is kept, links, ids, images, options, the cache, the corpus's invariants, 35 attacks |
| `test/plain.test.ts`, `test/tree.test.ts` | mail.plain and autolinks, mail.text and mail.links |
| `test/components.test.ts` | the tag table, the types, the dispatch and the files agree; the generated files are current |
| `test/check.test.ts` | `sinter check --strict` over the fixtures: no error, no warning |
| `test/static.test.ts` | an email folded at build time: no JavaScript, the HTML is the tree |
| `test/browser.test.ts` | Chromium under `script-src 'self'; style-src 'self'; require-trusted-types-for 'script'`: no violation, the styles applied; the CSP a folded email needs; render time and size |

