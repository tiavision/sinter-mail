# Proposal: MIME and OpenPGP structure in sinter-mail

Status: proposed, revised after review (revision 2). Follows [Later](sinter-mail.md#later) of the first
proposal. Why the structure belongs in the library is in [The case](#the-case).

## Goals

- **`mail.mime(bytes, options)`** reads a whole message into its headers, its bodies (each one ready for
  `mail.parse` or `mail.plain`), its attachments and its inline images. Browser and Node, a pure helper: the
  same bytes and options give the same frozen, JSON-shaped message.
- **Bodies are never joined.** One entry per body part, in reading order, each with what protected it. This is
  [decision 9](sinter-mail.md#decisions) carried into MIME.
- **OpenPGP structure, not OpenPGP crypto.** The library finds what the app must decrypt or verify, checks the
  message's shape strictly, reads the decrypted payload, applies protected headers, and labels each part
  encrypted, signed, or neither. Keys, decryption, verification and trust stay in the app.
- **A label never covers more than its part, and never more than the cryptography proves.** Encryption proves
  confidentiality, not who wrote it; a signature proves its signer wrote its part, and nothing else.
- **Safe for hostile input**, as `mail.parse` is: bounded work, no throw on malformed mail, nothing decoded
  twice into something else.

### Not in this proposal

S/MIME (the interface leaves room for it, [Decisions](#decisions), 9), parsing iCalendar (a `text/calendar`
part is handed over, not read), composing (apps build their own PGP/MIME; a writer could follow), Autocrypt
(headers are exposed; key handling is the app's).

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

### 1. One pure call

```ts
mail.mime(bytes: Uint8Array, options?: {
  prefer?: 'html' | 'text';                    // in multipart/alternative; default 'html'
  decrypted?: Record<string, Decrypted>;       // results of decrypt steps, by step id
  verdicts?: Record<string, Verdict[]>;        // results of verify steps, by step id
}): Message

mail.bytes(bytes: Uint8Array, ref: Ref, options?: { decrypted?: Record<string, Decrypted> }): Uint8Array
mail.imageType(bytes: Uint8Array): 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | null   // by magic number
```

An app calls `mail.mime` again with each result it gets, rather than calling back into a message: the call
works in a `data-sn-let`, the action that decrypts only stores its result in state, and the message stays a
plain value (no hidden reference to the input, nothing lost through `structuredClone` or JSON).

```html
<article data-sn-let="{ msg: mail.mime(raw, { decrypted, verdicts }) }">
```

The message holds **no bytes**. Attachments, inline images and steps hold a `Ref`, and an action reads the
bytes with `mail.bytes` when it needs them (to make a blob URL, to save a file, to decrypt). A typed array
cannot be frozen (`Object.freeze(new Uint8Array(1))` throws) and does not survive JSON, which a tree sent
from a server or folded at build time must.

### 2. The message

```ts
interface Message {
  type: 'message';
  headers: Headers;            // the headers to show (section 6)
  outer: Headers;              // the headers as transported
  headerSource: 'protected' | 'outer';
  confidential: string[];      // header names the sender sent only encrypted (section 6), lowercase
  parts: Part[];               // what to show, in reading order
  attachments: Attachment[];
  inline: Inline[];            // for mail.parse's `cid`, through blob URLs (section 3)
  calendar: Calendar[];        // text/calendar parts (iMIP), as text
  steps: Step[];               // what the app is asked to do (section 5); empty for plain mail
  summary: Summary;            // section 7
  problems: Problem[];         // what was malformed, refused or repaired; for diagnostics, never content
}

type Part = { id: string; contentType: string; protection: Protection } & (
  | { type: 'html'; html: string; legacyDisplay: boolean }
  | { type: 'text'; text: string; flowed: boolean; delsp: boolean }
  | { type: 'message'; message: Message }          // a forwarded message/rfc822, inline
  | { type: 'encrypted'; step: string | null }     // not decrypted (yet): pending, failed, or not offered
  | { type: 'report'; text: string }               // message/delivery-status and the like, as text
);

interface Headers {
  subject: string | null;
  from: Address[]; sender: Address[]; replyTo: Address[];
  to: Address[]; cc: Address[];
  date: string | null;         // ISO 8601, or null when unparseable
  messageId: string | null; inReplyTo: string[]; references: string[];
  list: [name: string, value: string][];       // List-Id, List-Unsubscribe, List-Unsubscribe-Post
  autocrypt: string[];                         // Autocrypt headers, unfolded
  raw: [name: string, value: string][];        // every header, unfolded, not decoded
}

interface Address { name: string | null; address: string; group?: string }

interface Ref { source: string; start: number; end: number; encoding: 'base64' | 'quoted-printable' | 'identity' }

interface Attachment {
  id: string;
  filename: string;            // made safe (section 4)
  contentType: string;         // as declared, lowercased; not trusted
  disposition: 'attachment' | 'inline' | null;
  contentId: string | null;
  size: number;                // decoded
  ref: Ref;
  protection: Protection;
}

interface Inline { contentId: string; attachment: string }   // the attachment's id
```

- **Ids** are paths: the root entity is `1`, its parts `1.1`, `1.2`, theirs `1.2.1` (as IMAP numbers them);
  inside a decrypted payload the path continues after the step's id and `/` (`1/1.2`). The same message gives
  the same ids, so an app can key state by them.
- **No map is keyed by the sender's strings.** Content-IDs, header names and list headers are in arrays of
  pairs: an object keyed by `__proto__` stores nothing.
- **Inline images** go to `mail.parse` as URLs: an action reads each `Inline`'s bytes with `mail.bytes`,
  checks `mail.imageType` (not the declared type) and makes a blob URL; `cid` is then the map of those URLs.
  An app whose server serves the parts keeps the `cid` template it has today.
- A `Part` goes straight to the existing helpers: `mail.parse(part.html, { …, cid, legacyDisplay:
  part.legacyDisplay })`, `mail.plain(part.text, { flowed: part.flowed, delsp: part.delsp })`.

### 3. Reading MIME

Our own reader, over bytes (RFC 2045 to 2049); the choice is argued in
[Our own reader or a dependency](#our-own-reader-or-a-dependency).

- **Bytes in, bytes kept.** Input is a `Uint8Array`. Each part is a byte range of the input (or of a
  decrypted payload); nothing is decoded before its charset is known. A string input is encoded as UTF-8,
  which suits tests and 7-bit fixtures; an 8-bit fixture is read from bytes.
- **Headers**:
  - unfolded; the raw value kept in `raw`, undecoded;
  - address lists **tokenized first, encoded words decoded after**, inside display names and comments only,
    so a decoded `<`, `>`, `,`, `@` or line break is text, never structure;
  - encoded words (RFC 2047) decoded, adjacent ones joined without the space between them, a multi-byte
    character split across two words joined before decoding; UTF-8 headers (RFC 6532);
  - parameters with RFC 2231 continuations and charsets (`filename*0*=`), and RFC 2047 words in `filename=`
    and `name=`, which Outlook and Gmail send against the standard;
  - dates by RFC 5322 with the obsolete forms clients send.
- **Bodies**: base64, quoted-printable, 7bit, 8bit and binary; decoded with the part's charset through
  `TextDecoder`. A missing charset on `text/*` is read as UTF-8; invalid UTF-8 falls back to windows-1252
  (what a byte that is not UTF-8 most often is); an unknown label decodes as UTF-8 and adds a problem. UTF-7
  (no `TextDecoder` has it) is decoded by the reader. Node without full ICU lacks some labels: those parts
  add a problem, and the guide says so.
- **Choosing what to show**:
  - `multipart/alternative`: the last part that can be shown (the standard's order is plainest first);
    `prefer` chooses between an HTML and a text candidate. **A text candidate that is wholly one armored
    message or one cleartext-signed block is chosen whatever `prefer` says**: inline-PGP senders put the
    armor in both alternatives, and the HTML one is never a step (section 5). The parts not chosen are
    neither parts nor attachments, and **their signatures and ciphertexts make no step and count for nothing
    in the summary**.
  - `multipart/related`: the root (`start`, else the first part) is shown; the rest are `inline`, matched by
    Content-ID or `Content-Location`; one the root does not reference is also an attachment.
  - `multipart/mixed` and unknown `multipart/*`: each part in order. A `text/plain` or `text/html` part
    without `Content-Disposition: attachment` and without a filename is shown; the rest are attachments.
  - `multipart/digest`: parts default to `message/rfc822`.
  - `multipart/report`: the human part is shown; `message/delivery-status`,
    `message/disposition-notification` and `text/rfc822-headers` are `report` parts; the returned message is a
    `message` part.
  - `message/rfc822` (and `message/global`): inline, a nested `Message`; as an attachment, an attachment the
    app may read with `mail.mime` again. A nested message never makes steps (section 5).
  - `text/calendar`: always in `calendar` (with its `method` parameter), and an attachment too, so it can be
    saved.
  - `application/pgp-keys`: an attachment, marked so the app can offer to import it.
- **Malformed mail** reads as a tolerant client reads it: a missing closing boundary ends the multipart at the
  end of its parent; a boundary line with trailing whitespace is a boundary; a part with no blank line after
  its headers has an empty body. Each is a problem, none throws.

### 4. Limits and safety

- **Bounded work**: linear in the input, boundaries found in one pass; nesting at most 32 levels, walked
  without recursion; at most 1,000 parts; header blocks at most 1 MB for the message's root (long recipient
  lists, `Received`, ARC and Microsoft headers) and 64 kB for a part, at most 1,000 fields each; at most 8
  levels of nested messages; at most 16 steps. Past a limit, the rest is one opaque attachment and a
  problem. A decoder's output is never larger than its input, so decoded size is bounded by the input's.
- **Filenames**: path separators, control characters, bidirectional controls (`U+202E`: `evil‮fdp.exe`) and
  leading dots removed, at most 255 characters keeping the extension; empty becomes `attachment`. The
  original is in `raw`.
- **Content types are not trusted**: the declared type is reported, lowercased and checked for syntax
  (`type/subtype`), and used only to choose what to show. Showing an attachment inline is the app's decision,
  by its own allowlist; an inline image's type comes from its bytes (`mail.imageType`).
- **Content-IDs**: angle brackets stripped; an id that appears twice keeps the first.

### 5. Encryption and signatures: the steps

`mail.mime` never decrypts or verifies. When the structure asks for it, `steps` lists what the app should do;
the app reads the bytes with `mail.bytes`, does it, and calls `mail.mime` again with the result.

```ts
type Step =
  | { id: string; kind: 'decrypt'; ciphertext: Ref; armored: boolean }
  | { id: string; kind: 'verify'; signed: Ref; signature: Ref; micalg: string | null; canonicalized: boolean }
  | { id: string; kind: 'verify-cleartext'; block: Ref; charset: string };

interface Decrypted {
  status: 'ok' | 'failed' | 'no-key' | 'locked' | 'unsupported';
  plaintext?: Uint8Array;      // with 'ok'
  integrity: boolean;          // the app checked an integrity-protected packet (SEIPD v1 with its MDC, or
                               // v2/AEAD) decrypted completely; false refuses the plaintext
  signatures?: Verdict[];      // signatures inside the ciphertext (OpenPGP's one-pass)
}

interface Verdict {
  status: 'good' | 'bad' | 'no-key' | 'expired' | 'revoked' | 'unsupported';
  fingerprint?: string;
  created?: string;            // ISO 8601
  signer?: string[];           // the addresses of the key's user IDs that the app trusts as the key's
}
```

What becomes a step, and nothing else:

- **PGP/MIME encrypted** (RFC 3156): the message's root is `multipart/encrypted;
  protocol="application/pgp-encrypted"` with exactly two parts, the first `application/pgp-encrypted`
  containing `Version: 1`, the second `application/octet-stream`. **Only the root is decrypted**: content
  decrypted from inside someone else's message cannot be told apart from theirs, and a reply would quote it to
  them. The same structure anywhere else is one `encrypted` part (`step: null`), not two loose attachments,
  so the app can offer to open it as a message of its own, in a view marked as such (Exchange rewrites
  `multipart/encrypted` into `multipart/mixed`, and list managers wrap encrypted mail with footers: this
  is where that mail ends up).
- **The app's result is checked.** A `Decrypted` without `integrity: true` shows nothing: a missing or
  failed MDC, a partial plaintext and a "ciphertext" that is only a signed or literal OpenPGP message are the
  app's to refuse (openpgp.js: `allowUnauthenticatedMessages: false`, and checking the message was
  encrypted). This is where EFAIL's CBC/CFB gadgets are stopped; never joining bodies stops its direct
  exfiltration.
- **PGP/MIME signed**: `multipart/signed; protocol="application/pgp-signature"` with exactly two parts, the
  second `application/pgp-signature`. Allowed **anywhere** but in an unchosen alternative or a nested
  message (a mailing list wraps a signed message in `multipart/mixed` and appends a footer), because the
  verdict labels only that part's subtree. `signed` is the first part's bytes, from the start of its headers to
  the line break before the next delimiter (that line break belongs to the delimiter). RFC 3156 has the
  receiver verify the canonical form, with CRLF line endings: bare LF line endings (maildir, mbox, JMAP blobs,
  `file:` fixtures) are converted to CRLF, nothing else is changed, and `canonicalized` and a problem say so.
  `mail.bytes` returns the canonical bytes.
- **Inline PGP**, in a `text/plain` body:
  - an armored message is a decrypt step only when it is the whole body (whitespace aside) **and** the body is
    the root message's only part shown: one among several parts, or inside a nested message, is an
    `encrypted` part without a step;
  - a cleartext-signed block is a `verify-cleartext` step only when `-----BEGIN PGP SIGNED MESSAGE-----` starts
    a line that is not quoted (`>`), its armor headers are only `Hash:`, and the body has at most 4 blocks;
    otherwise it is text and a problem. `block` is the block's bytes as sent with `charset`, so the app
    verifies what the sender signed, not a re-encoding. The signed text shown is the block's text with
    dash-escaping removed, which is exactly what is hashed; the text before and after the block are text
    parts of their own, unsigned;
  - armor inside HTML is never a step.

With a decrypt result, the plaintext is read with section 3 as the payload (a MIME entity, or for inline PGP
a body as it is), its parts labelled encrypted, and its own `multipart/signed` (sign then encrypt) becomes a
further step. A payload whose root is itself `multipart/encrypted` (encrypted twice) makes one more decrypt
step, at most once. A step without a result stays in `steps`, and its part is `encrypted` with `step` set: an
encrypted message shows nothing until decrypted, and the app can say why.

### 6. Protected headers

Read from the root of the cryptographic payload: the decrypted entity, or the signed part when the signed part
is the message's root or the root of a decrypted payload.

- **When they apply**: the payload's root carries protected headers when its Content-Type has the `hp`
  parameter (RFC 9788) or `protected-headers="v1"` (the older convention of Enigmail, Autocrypt, K-9 and
  Thunderbird, on the root whatever its type, `text/plain` included). Then `headerSource` is `'protected'`
  and **the whole set** comes from the payload: Subject, Reply-To, To, Cc, Date, Message-ID, In-Reply-To,
  References. A field the payload does not have is empty, not the outer one: an attacker re-sending an old
  ciphertext cannot add a `Reply-To` of their own next to an inner From.
- **From is the exception.** The protected From replaces the outer one only with a `good` verdict on a
  signature over the payload's root whose `signer` includes that address. Otherwise `headers.from` is the
  outer From and `summary.from` says whether the inner one differs. Encryption alone proves nothing about the
  author: anyone with the reader's public key can encrypt `From: ceo@…`.
- **Without protected headers** (older senders), `headerSource` is `'outer'`: the outer headers are shown as
  they are, and `summary.from` is `'unknown'` for decrypted content unless a signature binds it.
- **Addresses compare** by their addr-spec, ASCII case-insensitive in both parts, after Unicode NFC; nothing
  else is normalized.
- **Which headers were confidential**: with `hp="cipher"`, the outer headers the sender replaced or removed
  (listed by `HP-Outer` in the payload) are in `confidential`. An app writing an unencrypted reply uses the
  outer value of those, so it does not send the inner one in the clear.
- **Legacy display**, honoured only inside a payload whose root carries protected headers:
  - RFC 9788: a `text/plain` part with `hp-legacy-display="1"` loses its leading lines that are header fields,
    up to the blank line after them; an HTML part with it is `legacyDisplay: true`, and `mail.parse(html, {
    legacyDisplay: true })` drops the first `div` child of the body with class
    `header-protection-legacy-display` (only then: a class alone drops nothing);
  - the older convention: a `text/rfc822-headers; protected-headers="v1"` part first in the payload is a
    display part: hidden, and not read for headers, which always come from the payload's root.
- **The outer subject** of an encrypted message is often `...` or `[...]`; `headers.subject` is the inner one
  once decrypted.

### 7. Protection

```ts
interface Protection {
  encrypted: boolean;          // decrypted from the root's ciphertext
  signed: Verdict['status'] | 'pending' | null;   // the innermost signature covering this part
  step?: string;               // that signature's step, or the decrypt step
  signer?: string[];
}

interface Summary {
  encrypted: 'all' | 'some' | 'none';      // over parts and attachments
  signed: 'all' | 'some' | 'none';
  from: 'matches' | 'differs' | 'unknown' | null;   // null for plain mail
  headers: 'protected' | 'outer';
}
```

- `signed` is `'all'` only when **one** signature with a `good` verdict covers the payload's root and its
  `signer` includes `headers.from`; parts signed by other keys, or by a key not bound to the From, are
  `'some'`. `encrypted` is `'all'` when everything shown came from the root's ciphertext.
- `headers: 'outer'` with `signed: 'all'` is a signed body under unsigned Subject, To and Date, which can be
  replayed in another context: an app shows the badge on the body, not on the headers.
- An app shows a message-level badge only for `'all'`, and marks the parts otherwise. `'some'` is the case an
  attacker builds; it is also the mailing-list footer, which is why parts are labelled rather than the message
  refused.
- **Replies**: an app should not quote decrypted content into a reply unless `summary.from` is `'matches'`,
  or should ask first: the reply goes to the outer sender, who may only have forwarded someone else's
  ciphertext.

### 8. The package

```
sinter/
  mime.ts          mail.mime, mail.bytes, mail.imageType: imports no HTML parser
  mime/            the reader: headers, addresses, dates, encodings, structure, steps
```

Exported from the entry like `mail.plain`, and as `@tiavision/sinter-mail/mime` so `lazy` covers it; a page
without MIME pays nothing. `mail.parse` gains the `legacyDisplay` option. Budget: 12 kB gzip, to be measured
(no charset tables: `TextDecoder` has them; UTF-7 and the address and date grammars are the reader's). Pure: an
`.eml` in a `file:` resource folds at build time.

## Our own reader or a dependency

Being surveyed (the existing JavaScript MIME parsers against the needs of sections 1 to 5: bytes in, the part
tree, exact byte ranges, strict structure, bounded work, browser and Node without builtins, size); the
result and the decision will be here.

## Pitfalls from other MIME parsers

Being surveyed (published vulnerabilities of MIME parsers and mail clients, and the research on
encrypted-mail attacks), each mapped to this design; the result will be here.

## Decisions

1. **Our own MIME reader, pending the survey** ([Our own reader or a dependency](#our-own-reader-or-a-dependency)).
2. **No cryptography in the library.** Keys, decryption, verification and trust are the app's (openpgp.js
   in a `data-sn-call` action, a server, a hardware key); the library lists steps and reads results.
3. **One pure call, no bytes in the result.** Results go in as options; bytes come out through `mail.bytes`.
4. **Only the root is decrypted**, and the app must vouch for integrity. Other encrypted entities are one part
   the app may open on its own.
5. **Signatures anywhere shown, labels per part.** A verdict covers its part's subtree and nothing else;
   `'all'` needs one signature over the root by the From.
6. **Inline PGP only as the only body** for encryption; cleartext signatures only line-anchored, unquoted, with
   only `Hash:` headers, splitting the body.
7. **Protected headers as a set, From only when signed.** No field is mixed from inner and outer.
8. **Detection is structural.** Text that looks like armor in a quote, a forward or HTML is text.
9. **The steps are protocol-shaped, not PGP-shaped**, so S/MIME (`application/pkcs7-mime`,
   `multipart/signed; protocol="application/pkcs7-signature"`) can add step kinds without changing the
   message.

## Plan

1. The reader: headers, addresses, dates, encodings, structure, limits; a corpus of real messages (with
   consent, anonymized) and hostile ones (nesting, boundaries, encodings), and the known attacks
   ([Pitfalls](#pitfalls-from-other-mime-parsers)) as tests.
2. What to show: alternatives, related, mixed, digests, reports, attachments, inline, calendar, nested
   messages; the `mail.parse` and `mail.plain` hand-off.
3. Steps and results, tested with openpgp.js in the tests only (a dev dependency): messages from Thunderbird,
   Mailvelope, Proton, K-9/FairEmail, Delta Chat, Apple Mail with GPG Suite, and openpgp.js-based web
   composers; and the published attacks (EFAIL, signature spoofing, re-wrapped ciphertexts).
4. Protected headers, legacy display (`mail.parse`'s option), the summary.
5. The guide (a section in `docs/mail.md`, a recipe: a reader with decrypt, badges and attachments) and
   `llms.txt`.
6. A first app moves over ([For apps](#for-apps)).

## For apps

What an app with its own MIME and PGP handling changes to move over:

- **The reader renders from `mail.mime`** on the raw message; the app's own MIME parsing goes; its decrypt
  and verify functions become actions that store a `Decrypted` or `Verdict[]` by step id. Decrypt must report
  `integrity` honestly; verify must return only user IDs the app trusts as `signer`.
- **A server's encrypted and signed flags become hints**: they can keep choosing whether to fetch the raw
  message; the badges come from `summary` and each part's `protection`. A server-side parser can stay for
  search and the list; a disagreement then changes what is found, not what is shown as verified.
- **Badges follow the summary**: a message-level badge only for `'all'`, per-part marks otherwise, and a
  warning when `from` is `'differs'` or `'unknown'` on decrypted content.
- **Replies**: quote decrypted content only when `from` is `'matches'` (or after asking); in an unencrypted
  reply, use the outer value of the `confidential` headers.
- **The list**: encrypted subjects stay `...` until opened unless the browser keeps decrypted headers; that
  is the app's choice.

## Open questions

- **RFC 9788's details**, from memory and to be checked against its text before step 4: the `hp` values
  (`cipher`, `clear`), `HP-Outer`'s syntax, the exact legacy-display rules, and its advice on showing the
  inner From without a signature.
- **Signed but not encrypted, with protected headers**: a good signature's inner Subject wins (section 6).
  Is a differing outer Subject worth a problem of its own?
- **`prefer`**: whether an app needs more than `'html' | 'text'`.
- **Size**: whether 12 kB holds with UTF-7 and the address and date grammars.
