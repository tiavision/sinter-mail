# Stalwart mail-parser corpus

Messages copied unchanged from `resources/eml/` of
[stalwartlabs/mail-parser](https://github.com/stalwartlabs/mail-parser), commit
`267239755e5a7a60c2a0c6eecb18c71dffbe7e95` (2026-11-23).

## License and attribution

mail-parser is Copyright (C) 2020, Stalwart Labs LLC, licensed under either of the Apache License 2.0
(`LICENSE-APACHE-2.0.txt`) or the MIT license (`LICENSE-MIT.txt`), at your option (its `Cargo.toml`,
README and `LICENSES/`). Per-suite notes, kept as in the source:

| Directory | Files | Origin and license |
| --- | --- | --- |
| `rfc/` | 10 | the example messages of the MIME RFCs, as shipped by mail-parser under its license |
| `malformed/` | 24 | Dovecot test messages, Copyright (c) 2003-2018 Dovecot authors, MIT (`malformed/COPYING`); `023.eml` is a minimized fuzzer input reported against mail-parser |
| `thirdparty/` | 20 | Dovecot test messages, MIT (`thirdparty/COPYING`) |
| `regressions/` | 76 | mail-parser's own regression fixtures (its `regressions/README.md` says where each comes from) |
| `issues/` | 17 | mail-parser's fixtures for GitHub issues; no expected parse exists for these |

Not copied:

- `legacy/` (54 messages): Hunny Software's MIME samples, "Copyright © 2010 Hunny Software, Inc.", with no
  license that grants redistribution (`legacy/COPYING` in the source).
- `issues/107-image-first.eml`: its headers and parts are taken verbatim from a Hunny Software sample.
- Stalwart's expected parses (`*.json`, `*.crlf.json`): they describe Stalwart's data model. What we need from
  them is in `structure.json`.

## structure.json

Made by `derive.mjs`, which reads files only (the `.eml` and Stalwart's `.json` next to it in a checkout) and
prints JSON:

```sh
git clone https://github.com/stalwartlabs/mail-parser /path/to/mail-parser
git -C /path/to/mail-parser checkout 267239755e5a7a60c2a0c6eecb18c71dffbe7e95
node test/mime-corpus/stalwart/derive.mjs /path/to/mail-parser/resources/eml 267239755e5a7a60c2a0c6eecb18c71dffbe7e95 \
  > test/mime-corpus/stalwart/structure.json
```

For each message (keyed `suite/NAME.eml`) it gives what our reader must agree on, in any data model:

- `tree`: the content type of each entity (lowercased `type/subtype`; `text/plain` when absent, or
  `message/rfc822` inside a `multipart/digest`), the children of each multipart in order (`parts`), and the
  root of each `message/rfc822` or `message/global` (`message`);
- for each `text/*` part: `charset` (the parameter, lowercased, or null), `encoding` (the WHATWG name
  TextDecoder gives it, or null) and `text`, the first 40 code points of the decoded text;
- `problems`: codes the delimiter and header scan expects (`boundary-missing-close`, `no-header-end`);
- `lineEnds`: `crlf` or `lf` (the file's, which decides whether `NAME.crlf.json` or `NAME.json` was read).

Nothing is copied from Stalwart unchecked. `derive.mjs` reads the bytes itself by the proposal's rules (delimiter
lines, transport padding, the line break before a delimiter belonging to it, the first empty line ending the
headers, base64 and quoted-printable, WHATWG charsets) and keeps a message only where its reading and Stalwart's
agree on every part's header and body offset, the number of children of each multipart, and whether each
closed. A text prefix is kept only where Stalwart reported no decode problem, the label is a WHATWG one, the
prefix holds no C1 control or U+FFFD, and an independent decoding of the bytes starts with it; otherwise the
node's `textOmitted` says why.

Result: 97 messages with expectations (146 text prefixes, 25 omitted), 33 skipped, each listed in `skipped` with
the reason:

- 6 with mixed line ends (Stalwart parsed only CR-stripped and CRLF-normalized copies);
- 4 where Stalwart accepted a mid-line delimiter (`fallback_delimiter`) and 4 more where its reading of the
  close delimiter differs (a boundary made of dashes, a close delimiter mid-line): our exact delimiter rule
  reads them otherwise;
- 3 where the child counts differ, 5 where Stalwart reads a declared multipart or message as a leaf, 4 where
  the header end differs (3 `no_blank_line` disagreements, 1 header end Stalwart found and the scan did not);
- 3 with two Content-Type fields, 1 boundary longer than 70 characters, 1 boundary that starts with an
  ancestor's (`duplicate-field`, `boundary-invalid`: the reader's tree there is its own design choice, not
  Stalwart's);
- 2 with a transfer encoding on `message/rfc822` (Stalwart decodes and parses it; the proposal ignores it,
  `encoding-on-multipart`).

One kept message has a `note`: `thirdparty/011.eml` part 1 is `Headers\n\n--boundary`, an empty body whose
empty line is the delimiter's line break. RFC 2046 allows a body part without a body; the proposal's
`no-header-end` ("headers run to its end") would flag it, blocking. No expectation is asserted there; it is
worth settling in the proposal.
