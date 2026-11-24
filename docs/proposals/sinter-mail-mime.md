# Proposal: MIME and OpenPGP structure in sinter-mail

Status: proposed. Follows [Later](sinter-mail.md#later) of the first proposal, and replaces its plan to build
on postal-mime ([Decisions](#decisions), 1). Why the structure belongs in the library is in
[The case](#the-case).

## Goals

- **`mail.mime(bytes)`** reads a whole message into its headers, its bodies (each one ready for `mail.parse`
  or `mail.plain`), its attachments and its inline images. Browser and Node, a pure helper.
- **Bodies are never joined.** One entry per body part, in reading order, each with what protected it. This is
  [decision 9](sinter-mail.md#decisions) carried into MIME.
- **OpenPGP structure, not OpenPGP crypto.** The library finds what the app must decrypt or verify, checks the
  message's shape strictly, reads the decrypted payload, applies protected headers, and labels each body
  encrypted, signed, or neither. Keys, decryption, verification and trust stay in the app.
- **A label never covers more than its part.** A signature on one part does not make the message signed;
  decrypted content is never shown as the outer sender's without saying whether it is.
- **Safe for hostile input**, as `mail.parse` is: bounded work, no throw on malformed mail, nothing decoded
  twice into something else.

### Not in this proposal

S/MIME (the interface leaves room for it, [Decisions](#decisions), 8), parsing iCalendar
(a `text/calendar` part is handed over, not read), composing (apps build their own PGP/MIME; a writer could
follow), Autocrypt (headers are exposed; key handling is the app's).

## The case

A webmail app that shows encrypted mail without this library typically has a server that parses ordinary
mail and caches the bodies, and a browser that decrypts with openpgp.js and parses raw and decrypted messages
with a small MIME reader of its own. Such readers are short and take shortcuts; the ones below are each easy
to write and each has a consequence:

| | The shortcut | What follows |
| --- | --- | --- |
| Encrypted | decrypts the first `-----BEGIN PGP MESSAGE-----` anywhere in the message | an old ciphertext to the reader, wrapped in another sender's mail, is decrypted and shown as theirs, marked encrypted; a reply quotes the plaintext back to them |
| Signed | verifies an inline signed block found anywhere, then badges the whole message | a genuine signed snippet pasted into other text makes that text look verified |
| Detection | searches the raw bytes for `multipart/encrypted`, `-----BEGIN PGP` (server and browser) | a forwarded or quoted message is flagged encrypted or signed |
| Protected headers | Subject only (inner root, or a `text/rfc822-headers` part) | From, To, Date not recovered; the sender's legacy display text is shown in the body |
| Charsets | the whole message decoded as UTF-8 before parsing | 8-bit Latin-1 parts are garbled |
| Bodies | the first `text/html` and the first `text/plain` win | a later body part is lost |
| Limits | none on nesting or part count; recursive | a deeply nested message overflows the stack |
| Two parsers | the server's parser for cached bodies, the browser's for raw and decrypted | the same message can split differently |

The first two are the reason the structure belongs in the library rather than in each app.

## Design

### 1. The message

```ts
interface Message {
  type: 'message';
  headers: Headers;            // the headers to show: protected ones when there are any (section 5)
  outer: Headers;              // the headers as transported
  bodies: Part[];              // in reading order
  attachments: Attachment[];
  inline: Record<string, Attachment>;   // by Content-ID, for mail.parse's `cid`
  calendar: Calendar[];        // text/calendar parts (iMIP), as text
  crypto: Step[];              // what the app is asked to do (section 4); empty for plain mail
  protection: Summary;         // section 6
  problems: Problem[];         // what was malformed or refused, for diagnostics; never shown as content
}

type Part =
  | { type: 'html'; html: string; legacyDisplay: boolean; protection: Protection }
  | { type: 'text'; text: string; flowed: boolean; delsp: boolean; protection: Protection }
  | { type: 'message'; message: Message; protection: Protection };   // a forwarded message/rfc822, inline

interface Headers {
  subject: string | null;
  from: Address[]; sender: Address[]; replyTo: Address[];
  to: Address[]; cc: Address[];
  date: string | null;         // ISO 8601, or null when unparseable
  messageId: string | null; inReplyTo: string[]; references: string[];
  list: Record<string, string>;          // List-Id, List-Unsubscribe, List-Unsubscribe-Post
  autocrypt: string[];                   // Autocrypt headers, unfolded
  raw: [name: string, value: string][];  // every header, unfolded, encoded words decoded
}

interface Address { name: string | null; address: string; group?: string }

interface Attachment {
  filename: string;            // made safe (section 3)
  contentType: string;         // as declared, lowercased; not trusted
  disposition: 'attachment' | 'inline' | null;
  contentId: string | null;
  size: number;
  bytes: Uint8Array;           // decoded; a view, not a copy, where the transfer encoding allows
  protection: Protection;
}
```

A `Part` goes straight to the existing helpers: `mail.parse(part.html, { …, cid: inlineUrls, legacyDisplay:
part.legacyDisplay })`, `mail.plain(part.text, { flowed: part.flowed, delsp: part.delsp })`. The result is
deep-frozen; the same bytes give the same message.

### 2. Reading MIME

Our own reader, over bytes (RFC 2045 to 2049):

- **Bytes in, bytes kept.** Input is a `Uint8Array` (or an `ArrayBuffer`; a string is encoded as UTF-8, for
  tests and `file:` fixtures). Each part is a byte range of the input; nothing is decoded before its charset
  is known. A signed part's exact bytes are a `subarray` of the input (section 4).
- **Headers**: unfolded; encoded words (RFC 2047) decoded, adjacent ones joined without the space between
  them; UTF-8 headers (RFC 6532); parameters with RFC 2231 continuations and charsets (`filename*0*=`);
  address lists with display names, quoted strings, comments and groups; dates by RFC 5322 with the obsolete
  forms clients send.
- **Bodies**: base64, quoted-printable, 7bit, 8bit and binary; decoded with the part's charset through
  `TextDecoder` (every WHATWG label); an unknown charset decodes as UTF-8 and adds a problem. A missing
  charset on `text/*` is US-ASCII by the standard, read as UTF-8 (a superset that loses nothing).
- **Choosing bodies**:
  - `multipart/alternative`: the last part that can be shown (the standard's order is plainest first);
    `prefer: 'html' | 'text'` (default `'html'`) chooses between an HTML and a text candidate. The others
    are not bodies and not attachments.
  - `multipart/related`: the root (`start`, else the first part) is the body; the rest are `inline`.
  - `multipart/mixed` and unknown `multipart/*`: each part in order. A `text/plain` or `text/html` part
    without `Content-Disposition: attachment` and without a filename is a body; the rest are attachments.
  - `message/rfc822` (and `message/global`): inline, a nested `Message` body; as an attachment, an attachment
    the app may read with `mail.mime` again.
  - `text/calendar`: always in `calendar` (with its `method` parameter), and an attachment too, so it can be
    saved.
- **Malformed mail** reads as a browser-tolerant client reads it: a missing closing boundary ends the
  multipart at the end of its parent; a boundary line with trailing whitespace is a boundary; a part with
  no blank line after its headers has an empty body. Each is a problem, none throws.

### 3. Limits and safety

- **Bounded work**: linear in the input; nesting at most 32 levels (an iterative walk, no recursion); at most
  1,000 parts and 1,000 headers per part block, 64 kB per header block; past a limit, the rest is one opaque
  attachment and a problem. Base64 and quoted-printable decode in one pass.
- **Filenames**: path separators, control characters, bidirectional overrides (`U+202E`: `evil‮fdp.exe`)
  and leading dots removed, at most 255 characters keeping the extension; empty becomes `attachment`. The
  original is in `raw` headers for an app that wants it.
- **Content types are not trusted**: the declared type is reported, lowercased and checked for syntax
  (`type/subtype`), never used to decide anything but body choice. Showing an attachment inline is the app's
  decision, by its own allowlist.
- **Content-IDs**: angle brackets stripped; an id that appears twice keeps the first.

### 4. Encryption and signatures: the steps

`mail.mime` never decrypts or verifies. When the structure asks for it, `crypto` lists a step; the app does
it and calls back with the result, and gets a new message.

```ts
type Step =
  | { id: string; kind: 'decrypt'; ciphertext: Uint8Array; armored: boolean }
  | { id: string; kind: 'verify'; signed: Uint8Array; signature: Uint8Array; micalg: string | null }
  | { id: string; kind: 'verify-cleartext'; armored: string };

// the app decrypted step `id`; `signature` when the ciphertext was also signed (OpenPGP's one-pass)
mail.decrypted(message, id, plaintext: Uint8Array, signature?: Verdict): Message
// the app verified step `id`
mail.verified(message, id, verdict: Verdict): Message

interface Verdict {
  status: 'good' | 'bad' | 'unknown-key' | 'unsupported';
  signer?: string[];           // the e-mail addresses of the key's user IDs, when the key is known
}
```

What becomes a step, and nothing else:

- **PGP/MIME encrypted** (RFC 3156): the message's root is `multipart/encrypted;
  protocol="application/pgp-encrypted"` with exactly two parts, the first `application/pgp-encrypted`
  containing `Version: 1`, the second `application/octet-stream`. Anything else at the root, or the same
  structure anywhere but the root, is not a step: an encrypted part inside `multipart/mixed` is an
  attachment. **Only the root is decrypted**, because content decrypted from inside someone else's
  message cannot be told apart from theirs, and a reply would quote it to them.
- **PGP/MIME signed**: `multipart/signed; protocol="application/pgp-signature"` with exactly two parts, the
  second `application/pgp-signature`. Allowed **anywhere** (a mailing list wraps a signed message in
  `multipart/mixed` and appends a footer), because the verdict labels only that part's subtree. `signed` is
  the first part's exact bytes, from the start of its headers to the line break before the next delimiter
  (which belongs to the delimiter): not re-canonicalized, so a message mangled in transit fails as strict
  clients fail it.
- **Inline PGP** in a `text/plain` body: an armored message is a decrypt step only when it is the **whole**
  body (whitespace aside); a cleartext-signed block (`-----BEGIN PGP SIGNED MESSAGE-----`) is a
  `verify-cleartext` step wherever it is, and splits its body into text parts: the text before it, the
  signed text, the text after, each with its own protection. Armor inside HTML is never a step.

After `mail.decrypted`, the plaintext is read with section 2 as the payload (a MIME entity, or for inline PGP
a body as it is), its parts labelled encrypted, and its own `multipart/signed` (sign then encrypt) becomes a
further step. Protected headers are applied (section 5). A step whose result is not given stays in `crypto`,
and its part stays as it is: an encrypted message shows nothing until decrypted, and the app can say why.

### 5. Protected headers

Read from the root of the cryptographic payload (the decrypted entity, or the signed part when the signed
part is the root), as RFC 9788 (Header Protection for Cryptographically Protected Email) and the older
`protected-headers="v1"` convention (Enigmail, Autocrypt) both put them:

- **Which headers**: Subject, From, Sender, Reply-To, To, Cc, Date, Message-ID, In-Reply-To, References. A
  header on the payload's root replaces the outer one in `headers`; `outer` keeps what was transported.
  Headers are taken only from an encrypted payload, or a signed one with a `good` verdict: an unverified
  signed part's headers are not more trustworthy than the outer ones.
- **The sender**: `protection.from` (section 6) says whether the decrypted or signed content can be tied to
  the outer From: the protected From equals it, and, for a signature, a `signer` address equals it. The
  library compares; the app decides what to show.
- **Legacy display**: senders that cannot rely on protected headers being read repeat them at the top of the
  body. A `text/plain` part with `hp-legacy-display="1"` loses its lines up to the first blank line; an HTML
  part with it is `legacyDisplay: true`, and `mail.parse(html, { legacyDisplay: true })` drops the element
  with class `header-protection-legacy-display` (only then: a class alone drops nothing). The older form, a
  `text/rfc822-headers` part (or a `text/plain; protected-headers="v1"` part of only headers) first in the
  payload, is read as headers and is not a body.
- **The outer subject** of an encrypted message is often `...` or `[...]`; `headers.subject` is the inner
  one once decrypted. An app writing a reply must choose which to use: the inner one in an unencrypted reply
  sends it in the clear ([For apps](#for-apps)).

### 6. Protection

```ts
interface Protection {
  encrypted: boolean;          // decrypted from the root's ciphertext
  signed: Verdict['status'] | null;   // the innermost signature covering this part
  signer?: string[];
}

interface Summary {
  encrypted: 'all' | 'some' | 'none';  // over bodies and attachments
  signed: 'all' | 'some' | 'none';     // with a good verdict
  from: 'matches' | 'differs' | 'unknown' | null;   // section 5; null for plain mail
}
```

An app shows a message-level badge only for `'all'`, and marks the parts otherwise. `'some'` is the case an
attacker builds; it is also the mailing-list footer, which is why parts are labelled rather than the message
refused.

### 7. The package

```
sinter/
  mime.ts          mail.mime, mail.decrypted, mail.verified: imports no HTML parser
  mime/            the reader: headers, addresses, dates, encodings, structure, crypto steps
```

Exported from the entry like `mail.plain`, and as `@tiavision/sinter-mail/mime` so `lazy` covers it; a page
without MIME pays nothing. `mail.parse` gains the `legacyDisplay` option. Target: under 8 kB gzip (no
charset tables: `TextDecoder` has them). Pure: an `.eml` in a `file:` resource folds at build time, as text.

## Decisions

1. **Our own MIME reader, not postal-mime.** postal-mime joins a message's HTML parts into one string, does
   not give a part's exact bytes (needed to verify `multipart/signed`), and decides structure leniently where
   the crypto steps need it strict. MIME's grammar is small next to HTML's, and the library already holds a
   parser to its own standard.
2. **No cryptography in the library.** Keys, decryption, verification and trust are the app's (openpgp.js
   in a `data-sn-call` action, a server, a hardware key); the library asks for steps and takes verdicts.
3. **Only the root is decrypted.** Inner encrypted parts are attachments.
4. **Signatures anywhere, labels per part.** A verdict covers its part's subtree and nothing else.
5. **Inline PGP only as the whole body** for encryption; cleartext signatures split the body.
6. **Protected headers win** when encrypted, or signed with a good verdict; the outer ones stay readable.
7. **Detection is structural.** Text that looks like armor in a quote, a forward or HTML is text.
8. **The steps are protocol-shaped, not PGP-shaped**, so S/MIME (`application/pkcs7-mime`,
   `multipart/signed; protocol="application/pkcs7-signature"`) can add step kinds without changing the
   message.

## Plan

1. The reader: headers, addresses, dates, encodings, structure, limits; a corpus of real messages (with
   consent, anonymized) and hostile ones (nesting, boundaries, encodings).
2. Body choice, attachments, inline, calendar, nested messages; the `mail.parse` and `mail.plain` hand-off.
3. Crypto steps and `mail.decrypted` / `mail.verified`, tested with openpgp.js in the tests only (a dev
   dependency): messages from Thunderbird, Mailvelope, Proton, K-9/FairEmail, Delta Chat, and openpgp.js-based
   web composers.
4. Protected headers, legacy display (`mail.parse`'s option), the summary.
5. The guide (a section in `docs/mail.md`, a recipe: a reader with decrypt, badges and attachments) and
   `llms.txt`.
6. A first app moves over ([For apps](#for-apps)).

## For apps

What an app with its own MIME and PGP handling changes to move over:

- **The reader renders from `mail.mime`** on the raw message; the app's own MIME parsing goes; its decrypt
  and verify functions become the step handlers, returning a `Verdict` with the signer's addresses.
- **A server's encrypted and signed flags become hints**: they can keep choosing whether to fetch the raw
  message; the badges come from `protection`. A server-side parser can stay for search and the list; a
  disagreement then changes what is found, not what is shown as verified.
- **Badges follow the summary**: a message-level badge only for `'all'`, per-part marks otherwise, and a
  warning when `from` is `'differs'` or `'unknown'` on decrypted content.
- **Replies**: decide whether a reply to an encrypted message uses the inner subject (only when the reply is
  encrypted too).
- **The list**: encrypted subjects stay `...` until opened unless the browser keeps decrypted headers; that
  is the app's choice.

## Open questions

- **RFC 9788's details**: the `hp` Content-Type parameter (`cipher` / `clear`) and the `HP-Outer` header,
  which record what the outer headers were; whether reading them changes anything above (it may let the
  library tell a header the sender removed from one it never set). To be checked against the RFC text before
  step 4.
- **Signed but not encrypted, with protected headers**: a good signature's inner Subject wins (section 5).
  Is a differing outer Subject worth a problem of its own?
- **`prefer`**: whether an app needs more than `'html' | 'text'` (a per-sender choice is the app's anyway).
- **Size**: whether 8 kB holds with the address and date grammars.
