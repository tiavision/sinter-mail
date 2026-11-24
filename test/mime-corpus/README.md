# MIME test corpus

Inputs for the MIME reader of [the proposal](../../docs/proposals/sinter-mail-mime.md) (Plan, step 1), and what
the reader must do with them. The loader and the generators are in [`../mime-corpus.ts`](../mime-corpus.ts);
`../mime-corpus.test.ts` checks only that this corpus loads and is well-formed.

| Where | What | License |
| --- | --- | --- |
| `stalwart/` | 147 messages from Stalwart mail-parser's `resources/eml/` (commit `2672397`); `structure.json`: content-type trees, charsets and text prefixes for 97 of them, derived by `derive.mjs` and cross-checked against the bytes; 33 skipped with reasons. See [`stalwart/README.md`](stalwart/README.md). | Apache-2.0 OR MIT (Stalwart Labs); Dovecot's suites MIT |
| `charsets/jsmime-*.eml` | jsmime's `test/data/charsets` (12 parts, 11 charsets and encodings, in pairs that must decode equal) and `shift-jis-image`, from [mozilla-comm/jsmime](https://github.com/mozilla-comm/jsmime) commit `49547b5`; `*.expected.json` with the decoded strings | MIT, Copyright (c) 2013 Joshua Cranmer (`charsets/LICENSE-jsmime.txt`) |
| `charsets/encoded-words.json` | jsmime's 45 `decodeRFC2047Words` cases with jsmime's expected string and the proposal's (10 differ on purpose or are unsettled) | MIT, as above |
| `charsets/own.eml` | ours: 16 parts (ISO-8859-1/-2/-15, windows-1252, KOI8-R, Shift_JIS, ISO-2022-JP, GB18030, Big5, UTF-8, invalid UTF-8, no charset, UTF-7, an unknown label, ISO-2022-KR) and a Subject of four encoded words in four charsets; `own.expected.json` | this package's (MIT) |
| `hostile/` | 26 fixtures from other parsers' advisories and fix commits; `manifest.json`: source, what each attacks and the expected outcome in the proposal's terms, for these and for 21 generated inputs | inputs from postal-mime and Nodemailer tests (MIT-0); the rest ours |

Expected decoded strings come from Node's `TextDecoder`: Node v22.23.5, ICU 78.3, full ICU (`icu_small` false).
Without full ICU, Node lacks the CJK and some single-byte decoders and the charset fixtures cannot be rebuilt.

## The generators

`../mime-corpus.ts` exports `corpus(dir)` (every `.eml` under `test/mime-corpus/<dir>`, sorted, as
`{ name, path, bytes }`), `corpusJson(name)`, `latin1(s)`, `CORPUS_DIR`, and generators returning
`Uint8Array`, deterministic: `singlePart` (2 MiB body), `manyParts` (20,000), `deepNesting` (300),
`oversizedHeader` (2 MiB), `manyEncodedWords` (100,000), `manyInvalidEncodedWords`, `boundaryPrefixOfParent`,
`boundaryExtendsParent`, `missingCloseBoundary`, `transportPadding`, `lineEndMix`, `base64Junk`,
`pgpMimeEncrypted`, `exchangePgpMime`, `pgpMimeSigned(lineEnds)`, `postalMimeBoundaryNearMiss`,
`postalMimeManyAddresses`, `nodemailerDeepGroups`, `nodemailerGroupOpeners`; `generators` maps the manifest's
names to them with their default arguments. The PGP shapes carry placeholder armor; the tests with real ciphertexts and
signatures make them with openpgp.js (`../mime-crypto-kit.ts`).

## Regenerating

Every script reads only files and writes only into this directory; nothing in the cloned repositories is run.

```sh
git clone https://github.com/stalwartlabs/mail-parser /tmp/mail-parser     # then check out 267239755e5a7a60c2a0c6eecb18c71dffbe7e95
git clone https://github.com/mozilla-comm/jsmime /tmp/jsmime              # 49547b5e8a775c7c9491a9fce9e3952967157c62
cp /tmp/mail-parser/resources/eml/{rfc,malformed,thirdparty,regressions,issues}/*.eml …   # by suite; see stalwart/README.md
node test/mime-corpus/stalwart/derive.mjs /tmp/mail-parser/resources/eml 267239755e5a7a60c2a0c6eecb18c71dffbe7e95 > test/mime-corpus/stalwart/structure.json
node test/mime-corpus/charsets/build.mjs /tmp/jsmime    # own.*, jsmime-*, encoded-words.json
node test/mime-corpus/hostile/build.mjs                 # hostile/*.eml and manifest.json
```

## For the reader's author

- `field-dropped` (a header field past a field limit, section 4) is in section 2's problem table, informational;
  the manifest uses it.
- `Headers\n\n--b` (an empty body whose empty line is the delimiter's line break) is legal by RFC 2046 and reads
  as an empty body with no problem; `stalwart/thirdparty/011.eml` has one (`../mime-corpus-structure.test.ts`
  checks it). `no-header-end` is informational, for a part whose headers run to its end.
- The `signed-text-as-headers-*` fixtures are reconstructed from the proposal's description of MFSA 2023-55;
  the advisory itself was not reachable from where this corpus was assembled.
