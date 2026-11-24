# Proposal: MIME and OpenPGP structure in sinter-mail

Status: accepted for implementation, revision 7 (RFC 9788, the MIME ambiguity draft and Heyes's paper read in full, after three reviews, a survey of the existing parsers and a survey of their vulnerabilities). Follows [Later](sinter-mail.md#later) of the first
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
mail.mime(bytes: Uint8Array | string, options?: {
  prefer?: 'html' | 'text';                    // in multipart/alternative; default 'html'
  decrypted?: Record<string, Decrypted>;       // results of decrypt steps, by step id
  verdicts?: Record<string, Verdict[]>;        // results of verify steps, by step id
  open?: string[];                             // step ids of encrypted parts the reader chose to open (section 5)
}): Message

mail.bytes(bytes: Uint8Array | string, ref: Ref, options?: { decrypted?: Record<string, Decrypted> }): Uint8Array
mail.imageType(bytes: Uint8Array): 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | null   // by magic number
```

An app calls `mail.mime` again with each result it gets, rather than calling back into a message: the call
works in a `data-sn-let`, the action that decrypts only stores its result in state, and the message stays a
plain value (no hidden reference to the input, nothing lost through `structuredClone` or JSON).

```html
<article data-sn-let="{ msg: raw ? mail.mime(raw, { decrypted, verdicts, open }) : null }">
```

```ts
// the action: run the steps the message asks for, until none is pending, then store the results
// (every call awaited: with the package in `sinter({ lazy })`, an action's imports of it are stubs that return
// Promises; awaiting is harmless when it is not lazy)
export async function unlock(raw: Uint8Array, prior: Results, open: string[]): Promise<Results> {
  const r = { decrypted: { ...prior.decrypted }, verdicts: { ...prior.verdicts }, open };
  for (let msg = await mail.mime(raw, r); msg.steps.some((s) => s.state === 'pending'); msg = await mail.mime(raw, r)) {
    for (const s of msg.steps.filter((s) => s.state === 'pending')) {
      if (s.kind === 'decrypt') {
        const ciphertext = await mail.bytes(raw, s.ciphertext, r);
        r.decrypted[s.id] = await decrypt(ciphertext);
      } else {
        const bytes = (ref: Ref) => mail.bytes(raw, ref, r);   // verify awaits each call
        r.verdicts[s.id] = await verify(s, bytes);
      }
    }
  }
  return r;
}
```

- **The message holds no bytes.** Attachments, inline images, encrypted parts and steps hold a `Ref`, and an
  action reads the bytes with `mail.bytes` when it needs them (to make a blob URL, to save a file, to
  decrypt). A typed array cannot be frozen (`Object.freeze(new Uint8Array(1))` throws) and does not survive
  JSON, which a tree sent from a server or folded at build time must. The input itself may be a typed array
  in state: sinter's state is plain, mutable JavaScript.
- **Results are bound to the bytes they are for.** A step's id carries a digest of the bytes it covers
  (section 5), so a result stored for one message, or for an earlier version of it, matches no step of
  another: a verdict that arrives after the reader moved on cannot badge the next message. A result whose id
  matches no step is ignored and is an informational problem.
- **Invalid options throw**, as `mail.parse`'s do: `decrypted`, `verdicts` and `open` of the wrong type, or
  an entry with an unknown `status`, throw a `TypeError` naming it. Unknown ids do not throw (above).
- **Its own cache.** sinter's `memo()` calls through uncached for typed-array arguments, and a let is
  evaluated at every read, so `mail.mime` keeps its last result, as `mail.parse`'s `last()` does: the input
  compared by identity, `prefer` by value, and `decrypted`, `verdicts` and `open` entry by entry (by key, and
  each value by identity), because the options object is new at every read and state may be changed in
  place. Behind it, a small cache by input identity and options, bounded like `parse.ts`'s.
- **A string input** is encoded as UTF-8. It is for tests and for `file:` resources, which sinter reads as
  text: an `.eml` with 8-bit parts in another charset cannot fold faithfully, so such fixtures are kept 7-bit
  (quoted-printable or base64). A build folds with Node's `TextDecoder`, whose labels depend on its ICU
  (section 3).

### 2. The message

```ts
interface Message {
  type: 'message';
  headers: Headers;            // the headers to show (section 6)
  outer: Headers;              // the headers as transported
  sources: Sources;            // where each shown field came from (section 6)
  reply: Address[];            // whom a reply goes to (section 6)
  confidential: string[];      // header names the sender sent only encrypted (section 6), lowercase
  parts: Part[];               // what to show, in reading order
  attachments: Attachment[];
  calendar: Calendar[];        // text/calendar parts (iMIP), as text
  steps: Step[];               // section 5; empty for plain mail
  summary: Summary;            // section 7
  problems: Problem[];         // what was malformed, refused or repaired (below); never content
}

type Part = { id: string; contentType: string; protection: Protection } & (
  | { type: 'html'; html: string; legacyDisplay: boolean; inline: Inline[] }
  | { type: 'text'; text: string; flowed: boolean; delsp: boolean }
  | { type: 'message'; message: Message; ref: Ref }     // a forwarded message/rfc822, inline
  | { type: 'encrypted'; ref: Ref; step: string; reason: EncryptedReason }   // ref: the whole entity or armor block
  | { type: 'report'; text: string }                    // message/delivery-status and the like, as text
);

type EncryptedReason =
  | 'pending'                  // its decrypt step has no result yet
  | 'failed'                   // its result was not 'ok', or had no integrity
  | 'not-root'                 // not the message's root: the app may offer to open it (section 5)
  | 'over-limit';

interface Headers {
  subject: string | null;
  from: Address[]; sender: Address[]; replyTo: Address[];
  to: Address[]; cc: Address[];
  date: string | null;         // ISO 8601 with the sender's offset (`2026-11-24T09:30:00+01:00`); null when unparseable
  messageId: string | null; inReplyTo: string[]; references: string[];
  list: [name: string, value: string][];       // List-Id, List-Unsubscribe, List-Unsubscribe-Post
  autocrypt: string[];                         // Autocrypt headers, unfolded
  raw: [name: string, value: string][];        // every header, unfolded, not decoded
}

type Field = 'subject' | 'from' | 'sender' | 'replyTo' | 'to' | 'cc' | 'date' | 'messageId' | 'inReplyTo' | 'references';
type Sources = { [F in Field]: 'protected' | 'outer' };

interface Address {
  name: string | null;
  address: string | null;      // null when the addr-spec is ambiguous or malformed: never a guess
  group?: string;              // the group's name; an empty group (`undisclosed-recipients:;`) is one
                               // Address with name and address null
  suspicious?: true;           // section 3
}

interface Ref {
  source: 'input' | string;    // 'input', or the id of the decrypt step whose plaintext holds it
  start: number; end: number;  // byte offsets in that source
  encoding: 'base64' | 'quoted-printable' | 'identity';   // what mail.bytes undoes
  canonical?: true;            // mail.bytes also converts bare LF to CRLF (section 5)
  slice?: [number, number];    // offsets in the decoded bytes (Settled for implementation)
}

interface Attachment {
  id: string;
  filename: string;            // made safe (section 4)
  originalFilename: string | null;   // as decoded, before section 4's rules; for display only, never for saving
  contentType: string;         // as declared, lowercased; not trusted
  disposition: 'attachment' | 'inline' | null;
  kind: 'file' | 'related' | 'calendar' | 'message' | 'pgp-keys' | 'encrypted';
  contentId: string | null;
  size: number;                // decoded
  ref: Ref;
  protection: Protection;
}

interface Inline { contentId: string; attachment: string }   // an attachment's id

interface Calendar { part: string; method: string | null; text: string; attachment: string }

interface Problem {
  code: ProblemCode;           // the table below
  part: string | null;         // the entity or part it concerns
  blocking: boolean;           // whether it stops steps (section 3)
}
```

- **Ids** are paths. The root entity is `1`, its parts `1.1`, `1.2`, theirs `1.2.1`, as IMAP numbers them; a
  non-multipart root is `1` with no children. Ids continue through nested messages, as IMAP's do: a
  `message/rfc822` at `1.2` has its root's parts at `1.2.1`, `1.2.2`, so every id in a message, nested ones
  included, is unique. Inside a decrypted payload the path continues after the decrypt
  step's id and `/` (`1#3f…/1.2`). A text part split around cleartext-signed blocks (section 5) gives parts
  `<id>:1`, `<id>:2`, … in order. Step ids are in section 5. The same bytes and options give the same ids.
- **No map is keyed by the sender's strings.** Content-IDs, header names and list headers are in arrays of
  pairs: an object keyed by `__proto__` stores nothing. (`Sources` has fixed keys.)
- **Every related part is an attachment**, `kind: 'related'`, `disposition: 'inline'`: the reader does not
  scan HTML (it imports no HTML parser), so it cannot tell which ones the body references; an app lists the
  attachments of other kinds, or filters by `Inline`.
- **Inline images belong to their body.** An HTML part's `inline` is a set, decided without reading the HTML:
  the related parts of its own `multipart/related`, plus the parts elsewhere in the same message (not in a
  nested message) whose Content-ID is unique in the message and not among the first; in both cases only parts
  with the same `protection` as the body: an unsigned part outside a signed body cannot supply the image the signed body
  shows. A Content-ID that appears twice in a scope resolves to nothing there, and is a problem.
  `Content-Location` is never resolved.
- **Inline images go to `mail.parse` as URLs**: an action reads each `Inline`'s bytes with `mail.bytes`,
  checks `mail.imageType` (PNG, JPEG, GIF, WebP, AVIF by their magic numbers; never SVG, whatever the declared
  type) and makes a blob URL; `cid` is then the map of those URLs. A blob URL has the page's origin, so the
  type check is what keeps an attachment from becoming a document there. An app whose server serves the parts
  keeps the `cid` template it has today, and must apply the same rule when serving them.
- **A `Part` goes straight to the existing helpers**: `mail.parse(part.html, { …, cid, legacyDisplay:
  part.legacyDisplay, encrypted: part.protection.encrypted })`, `mail.plain(part.text, { flowed: part.flowed,
  delsp: part.delsp })`. With `encrypted: true`, `mail.parse` blocks remote images unless the call also says
  `consent: true` (the reader's click for this message, never a standing per-sender setting): a decrypted
  body makes no request on its own (EFAIL's channel, and a read receipt for content the sender meant to be
  private). `origins` is reported either way, for the "show images" control.

**Problems.** Each has a code; a blocking one stops every step in or below the entity it concerns, and in
or below its descendants' cryptographic structures (section 3, "near crypto"). The list is closed: a new
case gets a code and a row.

| Code | Blocking | When |
| --- | --- | --- |
| `boundary-missing-close` | yes | a multipart ends without its closing delimiter |
| `boundary-invalid` | yes | a `multipart/*` without a boundary, or one empty, longer than 70 characters, outside RFC 2046's `bchars` (a trailing space included), holding an encoded word, or starting with an ancestor's: the entity is one attachment of its bytes |
| `duplicate-field` | yes | a repeated Content-Type, Content-Transfer-Encoding or Content-Disposition |
| `duplicate-parameter` | yes | a repeated `boundary`, `charset`, `protocol`, `micalg`, `start`, `type`, `filename` or `name` |
| `parameter-conflict` | yes for `boundary`, `protocol`, `micalg`, `start`, `type`; no for filenames | two forms of one parameter with different values (`x`, `x*`, `x*0…`; spellings differing in case; `filename*`, `filename`, `name`): the RFC 2231 form wins, then section 4's filename order |
| `parameter-malformed` | yes | a `boundary`, `protocol`, `micalg`, `start`, `type` or `charset` that is not a clean token or quoted string (whitespace, a comment, junk after the quote, an unterminated quote), a comment hiding a parameter, or an RFC 2231 form of one of them: strict parsers read another value or none |
| `header-malformed` | yes | a header line without a colon (skipped), whitespace before the colon (name trimmed), a first line that is a continuation (dropped), a whitespace-only line inside the headers (a continuation, not the end) |
| `content-type-invalid` | yes | a Content-Type that does not parse: read as `text/plain; charset=us-ascii` (RFC 2045) |
| `encoding-on-multipart` | yes | a transfer encoding other than 7bit, 8bit or binary on `multipart/*` or `message/*` |
| `encoding-unknown` | yes | an unknown transfer encoding |
| `crypto-shape` | yes | a `multipart/encrypted` or `multipart/signed` not of the shape section 5 requires |
| `armor-headers` | no | an anchored cleartext-signed block with armor headers other than `Hash:`, or lines starting `-` not dash-escaped: no step for it |
| `limit` | yes | a limit of section 4 reached |
| `control-in-structure` | yes | a NUL or other control byte in any field name, or in a raw Content-Type, Content-Transfer-Encoding, Content-Disposition or MIME-Version value (and so its boundary); a bare CR anywhere in an entity's header block (a parser that ends lines at CR sees another field) |
| `integrity` | yes | a decrypt result without `integrity: true` |
| `duplicate-header` | no | a repeated From, Sender, Subject or Date (From: `summary.from` is `'unknown'`) |
| `canonicalized` | no | bare LF line ends converted to CRLF for a signature |
| `exchange-shape` | no | Exchange's rewritten encrypted message, read as `multipart/encrypted` (section 5) |
| `charset-unknown`, `charset-fallback` | no | an unknown label read as UTF-8; invalid UTF-8 read as windows-1252 |
| `base64-junk`, `qp-invalid` | no; padding mid-stream under a signature step, yes | characters outside the alphabet, padding mid-stream (other decoders stop there, so a signed part would read differently), a partial quantum; `=` not followed by two hex digits or by a line end, `=` as the last byte |
| `encoded-word-in-parameter` | no | an encoded word in a parameter: decoded in `filename`/`name` (Outlook, Gmail), literal elsewhere |
| `rfc2231-segments` | no | continuation segments out of order, repeated or missing |
| `content-id-duplicate` | no | a Content-ID twice in one scope |
| `field-dropped` | no | a header field past a field limit |
| `stale-result` | no | a result whose id matches no step |
| `address-ambiguous` | no | an addr-spec read as `null` |
| `no-header-end` | no | a part whose headers run to its end: legal (RFC 2046), an empty body |
| `legacy-display` | no | a `text/plain` part with `hp-legacy-display="1"` and no blank line: nothing dropped |

### 3. Reading MIME

Our own reader, over bytes (RFC 2045 to 2049); the choice is argued in
[Our own reader or a dependency](#our-own-reader-or-a-dependency).

- **Bytes in, bytes kept.** Each part is a byte range of the input (or of a decrypted payload); nothing is
  decoded before its charset is known.
- **Line ends, defined once**: CRLF and bare LF end a line, everywhere (headers, boundaries, bodies, signed
  bytes); a bare CR is not a line end and is kept as a character. The same rule applies to every boundary
  search and to the signed bytes' canonical form (section 5).
- **Headers**:
  - unfolded; the raw value kept in `raw`, undecoded;
  - structured fields (addresses, Content-Type, Content-Disposition, Message-ID lists) **tokenized first,
    encoded words decoded after**, and only in phrases (a display name, quoted or not: Outlook encodes inside
    quotes), comments and unstructured text, never in an addr-spec, a parameter name or a token, so a decoded
    `<`, `>`, `,`, `@`, quote or line break is text, never structure (Mailsploit, "Splitting the email atom");
  - an encoded word counts only as a whole atom after tokenizing (bounded by whitespace, a special or the field's
    ends, so `=?utf8?q?=61=62=63?=<x@y>` decodes its name), including whole atoms inside a quoted string (as
    most clients do); one glued inside
    an atom (`collab=?x?b?QA==?=psres.net`), or one whose encoded text holds a space or `?`, is literal text; RFC
    2231's language suffix (`=?utf-8*en?q?…?=`) is accepted and ignored; invalid UTF-8 inside one falls back to
    windows-1252 as in bodies. One with an unknown charset, or one
    `TextDecoder` rejects, is left as written (RFC 2047 §6.2), with `charset-unknown`;
  - every decoded value, `Headers` fields and filenames alike, has NUL, C0 controls, CR, LF and bidirectional
    controls removed (a TAB becomes a space); an app that reuses a value in a reply cannot inject a header with it. In a raw structural
    field (Content-Type, Content-Transfer-Encoding, Content-Disposition) a control byte is also the blocking
    `control-in-structure`: parsers disagree on it (the MIME ambiguity Internet-Draft makes NUL fatal);
  - an address list is read by the RFC 5322 grammar with its obsolete forms, iteratively (comments nested at
    most 8 deep, at most 1,000 addresses per field); an addr-spec the grammar cannot read one way only is
    `address: null`, which makes `summary.from` `'unknown'`, never a guess;
  - `suspicious`: the display name, after decoding, contains `@` or `<`, unless it is the address itself
    (ASCII case-insensitive, quotes aside); or the address uses a form other software reads differently: an
    encoded word anywhere in the addr-spec, `!`, `%` or `@` in the local part (quoted or not: a UUCP path, the
    percent hack), a group name by the same rule as a display name, a domain literal (`[…]`), or a source route (`@a,@b:x@y`, whose route is dropped); or the
    display name holds a character NFKC turns into `@` or `<` (`＠`, `﹫`, `＜`);
  - `address: null` also for a control, bidirectional, Unicode space or format character in the local part, an
    invalid group phrase (all its members), a `;` outside a group (the mailboxes on both sides), an encoded word in the domain, an unterminated comment or quote, a backslash outside
    a quoted string, and an `xn--` label a strict RFC 3492 decoder rejects (letters, digits and hyphens only;
    overflow-checked), that decodes to an ASCII special or to nothing non-ASCII, or fails UTS 46 (`address` keeps
    the A-label as sent);
  - strings are never narrowed to bytes (`& 0xff`, latin1): code points such as U+0140 that end in `0x40` stay
    what they are (Heyes's "Unicode overflows");
  - `MIME-Ambiguity-Results` and `Authentication-Results` are forgeable and never read to add or suppress a
    problem;
  - encoded words (RFC 2047) decoded, adjacent ones joined without the space between them, consecutive words
    of one charset joined into one buffer and decoded once (linear, and a multi-byte character split across
    two words comes out whole); UTF-8 headers (RFC 6532);
  - parameters with RFC 2231 continuations and charsets (`filename*0*=`), and RFC 2047 words in `filename=`
    and `name=`, which Outlook and Gmail send against the standard;
  - dates by RFC 5322 with the obsolete forms clients send, kept in the sender's offset.
- **Duplicates and conflicts** resolve one fixed way, each a problem (the table in section 2): a repeated
  MIME field or parameter, the first counts; a repeated From, Sender, Subject or Date, `headers` shows all
  From addresses and the first of the others.
- **Near crypto**, a blocking problem means no step: it stops the steps of the entity it concerns, its
  descendants, and of a cryptographic structure whose ancestors have it ("above" is the ancestors' MIME
  fields and the delimiters that bound the entity, not the root's From, Subject or Date). The part is shown
  unlabelled, so a parser that would have read the message another way cannot be steered into a badge.
  Informational problems (a charset fallback, canonicalized line ends) never stop a step.
- **Boundaries**: a delimiter line is exactly `--` and the boundary, then optional whitespace (RFC 2046's
  transport padding, legal and not a problem), then the line end (or `--` for the close); `--boundaryX` is not
  `--boundary`. A boundary that is empty or longer than 70 characters, a child's boundary that starts with an
  ancestor's, or an ancestor's that is the child's followed by `--` (the child's close line is the ancestor's
  delimiter to an outer-first parser), is `boundary-invalid`; the check stays within one source (a decrypted
  payload's boundaries are not compared with the outer message's).
- **Transfer encodings**:
  - base64 skips characters outside its alphabet, decodes per quantum (padding in the middle, as in
    concatenated chunks, ends that quantum and decoding continues), and drops a final partial quantum; each a
    `base64-junk` problem;
  - quoted-printable removes whitespace at the end of each encoded line (after a soft-break `=`, or on a line
    without one), never whitespace before `=`, which is content (`hello =\r\nworld` is `hello world`); keeps
    `=` not followed by two hex digits as it is (`qp-invalid`);
  - a transfer encoding other than 7bit, 8bit or binary on `multipart/*` or `message/*` is ignored
    (`encoding-on-multipart`); an unknown one makes the part an attachment, undecoded.
- **Charsets**: decoded with the part's charset through `TextDecoder`, WHATWG labels only. A missing charset on
  `text/*` is read as UTF-8; invalid UTF-8 falls back to windows-1252 (what a byte that is not UTF-8 most often
  is); any other label, UTF-7 included, decodes as UTF-8 and adds a problem. UTF-7 is not decoded because its
  escapes can hide text from whatever reads the message before the reader, and browsers dropped it for that
  reason. WHATWG's `replacement` labels (ISO-2022-KR and others) decode to one replacement character, as
  browsers do. Encoded words use the same labels, but one with an unknown label is left as written (above). An HTML part's `<meta charset>` is ignored: the MIME charset
  decides. Node without full ICU lacks some labels: those parts add a problem, and the guide says so.
- **Choosing what to show**:
  - `multipart/alternative`: the last part that can be shown (the standard's order is plainest first);
    `prefer` chooses between an HTML and a text candidate. **A text candidate that is wholly one armored
    message or one cleartext-signed block is chosen whatever `prefer` says**: inline-PGP senders put the
    armor in both alternatives, and the HTML one is never a step (section 5). The text and HTML of the parts
    not chosen are neither parts nor attachments, and **their signatures and ciphertexts make no step and count
    for nothing in the summary**; their other parts (Apple Mail nests attachments in the HTML branch) are still
    attachments, and a `text/calendar` alternative is still in `calendar`.
  - `multipart/related`: the root (`start`, else the first part) is shown; the rest are attachments of kind
    `related` (section 2).
  - `multipart/mixed` and unknown `multipart/*`: each part in order. A `text/plain` or `text/html` part
    without `Content-Disposition: attachment` and without a filename is shown; the rest are attachments.
  - `multipart/digest`: parts default to `message/rfc822`.
  - `multipart/report`: the human part is shown; `message/delivery-status`,
    `message/disposition-notification` and `text/rfc822-headers` are `report` parts; the returned message is a
    `message` part.
  - `message/rfc822` (and `message/global`): inline, a nested `Message`; as an attachment, of kind `message`,
    which the app may read with `mail.mime` again. A nested message makes no steps of its own and applies no
    protected headers; its encrypted parts are `not-root` parts, which the reader may open (section 5), and the
    step is in the outer message's `steps` (one list per call).
  - `text/calendar`: always in `calendar` (with its `method` parameter), and an attachment of kind `calendar`,
    so it can be saved. Its text is data for an iCalendar parser, never HTML: a description with markup is
    shown as text.
  - `application/pgp-keys`: an attachment of kind `pgp-keys`, so the app can offer to import it.
  - Opaque, never opened: `message/partial` (no reassembly), `message/external-body` (nothing fetched),
    TNEF (`winmail.dat`, `application/ms-tnef`) and uuencoded blocks in text: attachments, or text, as they
    are. Vendor headers (`X-Mozilla-External-Attachment-URL` and the like) are in `raw` and never acted on.
- **Malformed mail** reads as a tolerant client reads it: a missing closing boundary ends the multipart at the
  end of its parent (blocking near crypto); a part with no blank line after its headers has an empty body, which
  is legal (`no-header-end`, informational). None throws.

### 4. Limits and safety

- **Bounded work**: linear in the input, boundaries found in one pass; nesting at most 32 levels, walked
  without recursion; at most 1,000 parts; header blocks at most 1 MB for the message's root (long recipient
  lists, `Received`, ARC and Microsoft headers) and 64 kB for a part, at most 1,000 fields each; at most 8
  levels of nested messages; at most 16 steps; at most 64 encoded words per phrase and 4,096 per field.
- **Past a limit**: an entity past a structural limit (depth, parts, nested messages) is one attachment with
  its bytes, and a `limit` problem; a header block past its size, or a field past its counts, keeps what came
  before and drops the rest (`field-dropped`); a step past 16 is not offered.
- **One budget per call**: the limits count across everything one `mail.mime` call reads, the input, every
  decrypted payload and every nested message together, so feeding results back cannot multiply the work.
  The bytes read in one call are bounded at 256 MiB and one decrypted payload at 64 MiB; there is no ratio to
  the ciphertext, since OpenPGP compresses and the app has already decompressed. A decoder's output is never
  larger than its input (canonical line ends in `mail.bytes` at most double it).
- **No backtracking regular expressions**: the grammars are hand-written scanners; the test suite runs each
  hostile case under a time bound.
- **Filenames**:
  - which: `filename*` (RFC 2231), then `filename`, then `name`; RFC 2231 segments out of order, repeated or
    missing are a problem, and the segments present are joined in order;
  - removed: path separators, `:`, control characters, every bidirectional control (U+200E, U+200F, U+061C,
    U+202A to U+202E, U+2066 to U+2069: `evil‮fdp.exe`), leading dots, trailing dots and spaces;
  - a Windows reserved name (`CON`, `NUL`, `COM1` and the like, with any extension) gets a `_` prefix;
  - at most 255 characters keeping the extension; empty becomes `attachment`. `originalFilename` keeps the
    decoded name (controls removed) for display beside the safe one.
- **Content types are not trusted**: the declared type is reported, lowercased and checked for syntax
  (`type/subtype`), and used only to choose what to show. Showing an attachment inline is the app's decision,
  by its own allowlist; an inline image's type comes from its bytes (`mail.imageType`).
- **Content-IDs**: angle brackets stripped; see section 2 for duplicates.

### 5. Encryption and signatures: the steps

`mail.mime` never decrypts or verifies. When the structure asks for it, `steps` lists what the app should do;
the app reads the bytes with `mail.bytes`, does it, and calls `mail.mime` again with the result (the recipe in
section 1).

```ts
type Step = { id: string; state: 'pending' | 'done' | 'failed' } & (
  | { kind: 'decrypt'; part: string; ciphertext: Ref; armored: boolean }
  | { kind: 'verify'; part: string; signed: Ref; signature: Ref; micalg: string | null }
  | { kind: 'verify-cleartext'; part: string; block: Ref; charset: string }
);

interface Decrypted {
  status: 'ok' | 'failed' | 'no-key' | 'locked' | 'unsupported';
  plaintext?: Uint8Array;      // with 'ok'
  integrity: boolean;          // the app checked an integrity-protected packet (SEIPD v1 with its MDC, or
                               // v2/AEAD) decrypted completely, and that it was an encrypted message;
                               // false refuses the plaintext
  signatures?: Verdict[];      // signatures inside the ciphertext (OpenPGP's one-pass)
}

interface Verdict {
  status: 'good' | 'bad' | 'no-key' | 'expired' | 'revoked' | 'unsupported';
  fingerprint?: string;
  created?: string;            // ISO 8601
  signer?: string[];           // addresses of the key's user IDs that the app trusts as the key's
}
```

- **Step ids**: the path of the entity the step is for, `#`, and the first 16 bytes of the SHA-256 of the bytes
  it covers, in hex: the ciphertext for `decrypt`; the signed bytes (canonical) and the signature for
  `verify`; the block for `verify-cleartext`, whose path is the part's and `:` and the block's number
  (`1.1:2#…`). SHA-256 is a small synchronous implementation in the reader (`crypto.subtle` is async and not
  a fold global); a collision-resistant hash is needed because a verdict for one message must not be
  reusable for crafted bytes of another.
- **`steps` lists every step**, with its state: `pending` without a result, `done` with one the library
  accepted, `failed` with one it did not (no integrity, a decrypt status other than `ok`). An app runs the
  `pending` ones.

What becomes a step, and nothing else:

- **PGP/MIME encrypted** (RFC 3156): the message's root is `multipart/encrypted;
  protocol="application/pgp-encrypted"` with exactly two parts, the first `application/pgp-encrypted`
  containing `Version: 1`, the second `application/octet-stream`. Also:
  - **sign over encrypt**: the root is `multipart/signed` and its first part is that `multipart/encrypted`
    (rare, legal): a verify step for the root and a decrypt step for the first part;
  - **Exchange's rewrite**: the root is `multipart/mixed` whose parts are, in order, an optional
    `text/plain` with only whitespace, `application/pgp-encrypted` containing `Version: 1`, and
    `application/octet-stream` (Exchange's form of a `multipart/encrypted`, which Thunderbird reads the same
    way): read as `multipart/encrypted`, with an `exchange-shape` problem.

  **Only the root is decrypted on its own**: content decrypted from inside someone else's message cannot be
  told apart from theirs, and a reply would quote it to them. The same structure anywhere else is one
  `encrypted` part (`reason: 'not-root'`, with its `Ref`), not two loose attachments. **The reader may open
  it**: the part's `step` is the id its decrypt step would have (a digest-carrying id, as every step's), and an app that
  lists that id in `open` gets the step; a stale `open` matches nothing in another message; what it decrypts to is shown in
  that part's place, labelled encrypted, but never counted as the message's: `summary.encrypted` is `'some'`,
  its headers are not applied, and it counts for nothing in `summary.from`. This is where Exchange variants not matched
  above, list-manager footers around encrypted mail, and inline armor with a footer end up.
- **The app's result is checked.** A `Decrypted` without `integrity: true` shows nothing (`integrity`
  problem, the step `failed`): a missing or failed MDC, a partial plaintext and a "ciphertext" that is only a
  signed or literal OpenPGP message are the app's to refuse (openpgp.js: `allowUnauthenticatedMessages:
  false`, and checking the message was encrypted). This is where EFAIL's CBC/CFB gadgets are stopped; never
  joining bodies stops its direct exfiltration.
- **PGP/MIME signed**: `multipart/signed; protocol="application/pgp-signature"` with exactly two parts, the
  second `application/pgp-signature`. Allowed **anywhere** but in an unchosen alternative or a nested message
  (a mailing list wraps a signed message in `multipart/mixed` and appends a footer), because the verdict
  labels only that part's subtree. `signed` is the first part's bytes, from the start of its headers to the
  line break before the next delimiter (that line break belongs to the delimiter). RFC 3156 has the receiver
  verify the canonical form, with CRLF line endings: when the part has bare LF line endings (maildir, mbox,
  JMAP blobs, `file:` fixtures), the `Ref` is `canonical`, `mail.bytes` converts them to CRLF and changes
  nothing else, and the `canonicalized` problem (informational) says so. The signed part's text is never
  re-read as headers unless it is a MIME entity, and a blocking problem inside the signed subtree leaves its
  parts `signed: null` whatever the verdict.
- **Inline PGP**, in a `text/plain` body:
  - an armored message is a decrypt step only when it is the whole body (whitespace aside) **and** the body is
    the root message's only part shown (or the text alternative chosen by the rule of section 3); armor with
    text around it, one among several parts, or inside a nested message is an `encrypted` part with
    `reason: 'not-root'`, which the reader may open;
  - a cleartext-signed block is a `verify-cleartext` step only when `-----BEGIN PGP SIGNED MESSAGE-----` starts
    a line that is not quoted (`>`), its armor headers are only `Hash:`, every line of the signed text starting
    with `-` is dash-escaped, and the body has at most 4 blocks. A quoted, unanchored or fifth block is plain
    text, with no problem (a reply that quotes a signed message is ordinary); an anchored block with other armor
    headers or a line starting `-` that is not dash-escaped is text and an `armor-headers` problem, which is
    informational: the block makes no step, and nothing else changes. The rules make the reader's reading a strict subset of what OpenPGP implementations accept.
    `block` is the block's bytes as sent, with `charset`, so the app verifies what the sender signed, not a
    re-encoding. The signed part shown is the signed text with dash-escaping removed and each line's trailing
    whitespace removed (what text-mode hashing covers; RFC 9580), never read as `flowed`, so unsigned trailing
    spaces cannot rejoin lines; the text before and after the block are text parts of their own, unsigned;
  - armor inside HTML is never a step.
- **Not steps**: separately encrypted attachments (`.pgp`, `.gpg`, `.asc` files, as Enigmail and GpgOL send
  them) are attachments of kind `encrypted`; the app may decrypt the file itself, outside the message.

With a decrypt result, the plaintext is read with section 3 as the payload (a MIME entity, or for inline PGP
a body as it is), its parts labelled encrypted, and its own `multipart/signed` (sign then encrypt) becomes a
further step. A payload whose root is itself `multipart/encrypted` (encrypted twice) makes one more decrypt
step, at most once. A step without a result leaves its part `encrypted` with `reason: 'pending'`: an encrypted
message shows nothing until decrypted, and the app can say why.

### 6. Protected headers

Read from the root of the cryptographic payload: the decrypted entity, or the signed part when the signed part
is the message's root or the root of a decrypted payload. Opened parts (section 5) and nested messages have
none.

- **When the payload counts**: a decrypted payload counts once decrypted (`done`), whatever its signatures
  say, From aside (below). A signed-only payload (a root `multipart/signed`, not encrypted; RFC 9788 gives it
  `hp="clear"`) counts only with a `good` verdict: while it is `pending`, `bad`, `no-key` or anything else,
  `headers` are the outer ones and every source is `'outer'`. This is stricter than RFC 9788 §4.3.1, which takes
  the payload's values and marks them unprotected; deliberately, since an unverified signed part's headers are no
  better than the outer ones and showing them invites trust. Signatures inside the ciphertext (`Decrypted.signatures`) are signatures over the
  payload's root, for `signed`, `summary` and From alike.

- **When they apply**: the payload's root carries protected headers when its Content-Type has the `hp`
  parameter (RFC 9788, values `cipher` and `clear`; ignored anywhere but the payload's root, §4.1) or
  `protected-headers="v1"` (the older convention of Enigmail, Autocrypt, K-9 and Thunderbird, from the
  Autocrypt draft that preceded RFC 9788, on the root whatever its type, `text/plain` included). `hp="cipher"`
  never means the message was encrypted (§2.1.1): only a `done` decrypt step does.
- **With `hp`, the whole set** comes from the payload: Subject, Sender, Reply-To, To, Cc, Date, Message-ID,
  In-Reply-To, References. RFC 9788 has the sender copy every non-structural field (§5.2.1), and a receiver
  not render an outer-only value (§4), so a field the payload does not have is empty, not the outer one: an
  attacker re-sending an old ciphertext cannot add a `Reply-To` of their own. Fields added in transit
  (`List-*`, `Archived-At`) are the exception the RFC names (§7), and are outer-only here anyway.
- **With `protected-headers="v1"`, field by field**: a field the payload has replaces the outer one, others
  stay outer (K-9 protects only the Subject; senders differ on Date). Reply-To is the exception: it is taken
  from the payload only, empty if the payload has none, since a reply is where a re-sent ciphertext pays off.
- **From, in both forms**: the protected From replaces the outer one only with a `good` verdict on a signature
  over the payload's root whose `signer` includes that address. Otherwise `headers.from` is the outer From and
  `summary.from` says whether the inner one differs. Encryption alone proves nothing about the author: anyone
  with the reader's public key can encrypt `From: ceo@…`. RFC 9788 asks the same: on a mismatch without a
  valid, correctly bound signature, warn and show both (§4.4.1–4.4.3); the comparison is with the actual outer
  From.
- **`reply`**: whom a reply goes to. With protected headers in an encrypted payload, the protected Reply-To,
  else the protected From, even when the shown From is the outer one: RFC 9788 has replies use only the
  protected fields for recipients (§4.4.4, §6.2), which also sends a reply to a re-sent ciphertext to its
  author, not to whoever re-sent it. Otherwise the shown Reply-To, else the shown From.
- **`sources`** records, for every field, whether the shown value came from the payload or from outside.
  Fields that exist only outside (`list`, `autocrypt`, `raw`) are never protected: an app must not let them
  change what it does with encrypted content (the Delta Chat group-membership attack used such a header).
- **Without protected headers** (older senders), every source is `'outer'`.
- **Addresses compare** as RFC 9788 §4.4.5 has them: the domain converted from U-labels to A-labels, then both
  parts ASCII case-insensitive; nothing else is normalized. A `null` address, or a domain whose labels do not
  convert, never matches.
- **Which headers were confidential**, decided only from inside the payload (RFC 9788 §4.3.1; anyone in transit
  can change the outer fields, §11.3):
  - with `hp="cipher"` on the payload of a `done` decrypt step, a protected field is confidential unless an
    `HP-Outer` field in the payload root's header section has the same name (ASCII case-insensitive) and the
    same unfolded value. `HP-Outer` is `name: value`, split at the first colon and the whitespace after it
    (§4.2.1); anywhere else it is ignored (§2.2). A protected field whose name no `HP-Outer` lists was removed
    from the outside altogether;
  - with `hp="clear"` on an encrypted payload, nothing is confidential: the encryption was probably added in
    transit (§10.2); without a decrypt step, nothing either;
  - with `protected-headers="v1"` on an encrypted payload (no `HP-Outer` exists there), a protected field whose
    outer value differs or is absent is confidential, so the usual `...` subject is covered;
  - each entry of `confidential` is the field name; an app writing an unencrypted reply uses the `HP-Outer`
    value for it (in `raw` of the payload, or the outer value under v1), or leaves the field out (§6.1.2).
- **Legacy display**, honoured only in the payload of a `done` decrypt step (RFC 9788 §4.5.3.1; a signed-only
  message has none, §4.5.1):
  - RFC 9788, when the payload's root has `hp`: the parameter `hp-legacy-display="1"` is on the leaf
    `text/plain` or `text/html` part (on the root itself when the payload is one part). A `text/plain` part
    loses everything up to and including its first blank line, after charset decoding (§4.5.3.2); without a
    blank line nothing is dropped (`legacy-display`). An HTML part is `legacyDisplay: true`, and
    `mail.parse(html, { legacyDisplay: true })` drops every `div` of the body with class
    `header-protection-legacy-display` (§4.5.3.3; only then: a class alone drops nothing). Dropped content
    is also gone from text quoted into a reply (§4.5.3), since it is not in the tree;
  - the older convention: an encrypted `multipart/mixed` payload with `protected-headers="v1"` and exactly two
    parts, the first `text/plain` or `text/rfc822-headers` with `protected-headers="v1"`: the first part is a
    display part, hidden, and not read for headers, which always come from the payload's root; the second is the
    body. ("Memory Hole" was the convention's earlier name, not another scheme.)
- **Not supported**: RFC 8551's older form, a `message/rfc822` wrapped as the whole payload (RFC 9788 §4.10),
  is shown as a nested message, without applying its headers.
- **The outer subject** of an encrypted message is often `...` or `[...]`; `headers.subject` is the inner one
  once decrypted.

### 7. Protection

```ts
interface Protection {
  encrypted: boolean;          // decrypted from a ciphertext (the root's, or an opened part's)
  opened?: true;               // from a part the reader opened (section 5)
  signed: Verdict['status'] | 'pending' | null;   // the innermost signature covering this part
  step?: string;               // that signature's step, or the decrypt step
  signer?: string[];
}

interface Summary {
  encrypted: 'all' | 'some' | 'none';      // over parts and attachments; opened parts count as 'some'
  signed: 'all' | 'some' | 'none';
  from: 'matches' | 'differs' | 'unknown' | null;
}
```

- **Several verdicts for one step** (several signatures, or several keys): the part's `signed` is `good` if any
  verdict is `good`, and `signer` is the union of the good verdicts' signers; otherwise the first status
  present in the order `bad`, `revoked`, `expired`, `no-key`, `unsupported`.
- **`summary.signed`** is `'all'` only when **one** signature with a `good` verdict covers the payload's root
  (the message's root, or the root of the decrypted payload) and its `signer` includes the address of
  `headers.from`; parts signed by other keys, or by a key not bound to the From, are `'some'`. `encrypted` is
  `'all'` when everything shown came from the root's ciphertext.
- **`summary.from`**, decided in this order:

  | Case | `from` | `headers.from` |
  | --- | --- | --- |
  | nothing is encrypted and nothing shown is signed | `null` | outer |
  | `headers.from` has not exactly one address, or a `null` one | `'unknown'` | outer |
  | a good signature over the payload's root has a `signer` including the From to show: the protected From when the payload has one, else the outer From | `'matches'` | that From |
  | protected headers carry a From whose address differs from the outer one | `'differs'` | outer |
  | anything else (encrypted and unsigned, signed by another key, a signature over a part only) | `'unknown'` | outer |

- `sources` with `'outer'` fields and `signed: 'all'` is a signed body under unsigned Subject, To and Date,
  which can be replayed in another context: an app shows the badge on the body, not on the headers.
- An app shows a message-level badge only for `'all'`, and marks the parts otherwise. `'some'` is the case an
  attacker builds; it is also the mailing-list footer, which is why parts are labelled rather than the message
  refused.
- **Replies**: a reply goes to `reply` (section 6). An app should still not quote decrypted content into a reply
  unless `summary.from` is `'matches'`, or should ask first: without protected headers, `reply` is the outer
  sender, who may only have re-sent someone else's ciphertext.

### 8. The package

```
sinter/
  mime.ts          mail.mime: options, cache; imports the reader by its specifier
  bytes.ts         mail.bytes, mail.imageType: imports no reader
  mime/            the reader, behind `@tiavision/sinter-mail/mime`: headers, addresses, dates, encodings,
                   structure, steps, SHA-256; mime/decode.ts the decoders and canonical line ends, which
                   bytes.ts imports relatively
```

- **The import graph, as for `mail.parse`**: sinter's lazy rule is per declaring module. `mime.ts` imports the
  reader as `@tiavision/sinter-mail/mime` (a new `exports` entry, `./mime` → `./sinter/mime/index.ts`), never by
  a relative path, so with `sinter({ lazy })` `mail.mime` is a lazy helper: in a let, undefined until the
  reader has loaded. `bytes.ts` declares `mail.bytes` and `mail.imageType` and imports no reader, so they are
  ordinary helpers in markup. `sinter.helpers.ts` re-exports each from its declaring module, as it does
  `plain.ts` and `tree.ts`.
- **In actions**, with the package lazy, every import of it is a stub that returns a Promise, so every call is
  awaited (the recipe in section 1), whatever the function is in the package.
- `mail.parse` gains the `legacyDisplay`, `encrypted` and `consent` options (done): `legacyDisplay` in `optionsOf`,
  its `last()` comparison and its cache key; `encrypted` without `consent` folded into `images` as `'block'`, so it
  shares plain `'block'`'s tree and needs no key of its own.
- Budget: 12 kB gzip, to be measured (no charset tables: `TextDecoder` has them; the address and date
  grammars and SHA-256 are the reader's). Pure: an `.eml` in a `file:` resource folds at build time, as text
  (section 1).

## Our own reader or a dependency

Our own. The existing parsers were measured against what sections 1 to 5 need: (1) bytes in, a charset per
part; (2) the part tree, bodies not joined; (3) exact byte ranges, for `multipart/signed`; (4) the strict
structure visible, **every repair of malformed structure recorded**; (5) bounded work, past a limit a problem
rather than a throw; (6) browser and Node without builtins, ESM, under `script-src 'self'` (so no
WebAssembly), maintained; (7) RFC 2047, 2231, addresses, dates. Sizes are minified and gzipped, bundled with
esbuild for the browser; behaviour was probed on the bundled code.

| Package | Last release | Size | Meets | Fails |
| --- | --- | --- | --- | --- |
| postal-mime 4.2.1 | 2026-11 | 30.0 kB | 1, 6, 7; 5 partly | 2 (joins bodies with `\n`), 3 (the tree is internal, no offsets), 4; a limit rejects the whole message; recursive |
| mailparser 3.15 | 2026-11 | Node only (422 kB) | 1, 3 (through mailsplit), 7 | 2, 6 (`stream`, `buffer`, `crypto`, iconv); in maintenance, pointing to postal-mime |
| @protontech/jsmimeparser 3.0.2 | 2025-08, deprecated | 8.5 kB | 1, 7; 4 partly (raw API) | 2 (joins with `<br>`), 3, 5 (no limits; recursion overflows on 20,000 parts), 6 (archived) |
| typescript-email-parser 1.0 (a port of Stalwart's Rust mail-parser) | 2026-08 | 24.4 kB for the MIME layer alone | 1, 2, 3 (exact RFC 3156 range), 7; walks without recursion | 4 ("tolerant and best-effort": repairs unrecorded, one `is_encoding_problem` flag per part), 5 (no part, depth or header limits; `maxBytes` throws), 6 (CommonJS, one maintainer, no security policy) |
| Stalwart mail-parser, built to WebAssembly | (Rust, maintained) | about 220 kB of wasm | 1, 2, 3, 7; fuzzed, in production | 4 (lenient, as above), 6 (instantiating WebAssembly needs `'wasm-unsafe-eval'` in `script-src`; a Rust toolchain in the build); the published build, mail-parser-wasm, flattens to one HTML and one text |
| emailjs-mime-parser 2.0.7 | 2019 | 226 kB | — | 1, 3, 5 (`fromCharCode.apply` overflows on 2 MB), 6 |
| letterparser 0.1.8 | 2024 | 3.5 kB | size | 1 (strings only), 3, 5, 7 (no RFC 2231) |
| eml-parse-js 1.2 beta | 2025 | 204 kB | — | 1, 3, 5, 6 |
| eml-format, mailparser-mit | 2019 | Node only | — | 6 |

The decision does not rest on size; without the budget it is the same:

- **Repairs must be visible.** The crypto steps are refused when the structure around them was ambiguous or
  repaired (section 3, [Decisions](#decisions), 8): that is what keeps a lenient reading from being steered
  into a badge. Every candidate that reads the tree well is lenient and silent about it, by design. Recording
  repairs is not a wrapper around such a parser; it is the boundary scan again, which is half the reader.
- **Limits must be problems, not throws.** A message past a limit still shows what it can (section 4). The
  candidates have no limits (typescript-email-parser, jsmime) or reject the whole message (postal-mime);
  adding them means patching the walk, which means a fork.
- **The policy rules out WebAssembly.** The best-tested parser, Stalwart's, would need `'wasm-unsafe-eval'`,
  and sinter-mail renders under `script-src 'self'`.
- **A fork is ours anyway.** postal-mime would need its core forked to expose the tree and byte ranges, and
  its advisories (three in a month: quadratic RFC 2047 decoding, boundary matching, address spoofing) would
  become merges into the fork. typescript-email-parser would need repairs recorded, limits added, conversion
  to ESM, and a single maintainer's code adopted, with every bug it shares with Stalwart ours to notice. What
  is worth taking from both, the offset model and the stack walk, is taken as design (below).
- **The bugs are in what we must own anyway**: other parsers' advisories are in encoded-word joining,
  boundary matching, address parsing and recursion ([Pitfalls](#pitfalls-from-other-mime-parsers)), which
  the crypto steps depend on most.
- **Size settles it further**: every candidate that works is 24 kB or more, against a budget of 12 kB;
  `TextDecoder` already holds the charsets.

Borrowed, with their licenses:

- **Stalwart mail-parser** (Apache-2.0 or MIT): its `resources/eml/` corpus with expected results, its fuzz
  targets (parse, limits, fields, charsets), its offset model (header, body and end offsets per part) and its
  explicit-stack walk, as designs.
- **postal-mime** (MIT-0): the notes in its boundary stack (ancestor boundaries, whitespace on delimiter
  lines) and its address parser (quadratic and greedy-search pitfalls), and each advisory's input, as hostile
  fixtures.
- **jsmime** (MIT): Mozilla's mixed-charset test set.
- **What to avoid**, as hostile tests: one 2 MB part, 20,000 parts, nesting 300 deep, an oversized header
  block.

## Pitfalls from other MIME parsers

Published vulnerabilities of MIME parsers and mail clients, and the research on encrypted mail, each mapped to
where this design answers it. Surveyed for this revision; PortSwigger's paper and the MIME ambiguity
Internet-Draft (an individual submission, draft-chen-email-mime-ambiguity-defense-00) were later read in full.

| Class | Seen in | This design |
| --- | --- | --- |
| Address parse differentials, sender spoofing | Python [CVE-2023-27043](https://access.redhat.com/articles/7051467); postal-mime before 4.2.1 ([domain truncation](https://www.vulncheck.com/advisories/postal-mime-before-4.2.1-sender-spoofing-via-address-parser-domain-truncation)); Nodemailer [GHSA-mm7p-fcc7-pg87](https://github.com/advisories/GHSA-mm7p-fcc7-pg87) (quoted local part); Thunderbird (malformed From) | the grammar, `address: null` rather than a guess, `'unknown'` (section 3) |
| Encoded words smuggled into structure | Mailsploit (2017, Thunderbird and others: an encoded NUL and `@`); Gareth Heyes, [Splitting the email atom](https://portswigger.net/kb/papers/rclapqr/splitting-the-email-atom.pdf) (2024: encoded `@ , < >`); Python (an encoded comma when folding) | tokenize first, decode only in phrases and comments; controls removed; `suspicious` (section 3) |
| Header injection through decoded values | Python [CVE-2024-6923](https://openwall.com/lists/oss-security/2024/08/01/3); MimeKit (CRLF in a quoted local part) | CR, LF, NUL removed from every decoded value (section 3) |
| Duplicate or conflicting fields and parameters | Amavis [CVE-2024-28054](https://gitlab.com/amavis/amavis/-/work_items/112) (two `boundary` parameters); "Composition Kills" (USENIX Security 2020, several From); Inbox Invasion ([CCS 2024](https://www.jianjunchen.com/p/inbox-invasion.CCS24.pdf); [Black Hat Asia 2025](https://citation.thinkst.com/talk/96163): evasions across detectors and clients) | first counts, a problem, no step near crypto (section 3) |
| Boundary ambiguity | Inbox Invasion; contradictory or prefixed boundaries | exact delimiter rule; prefixes a problem (section 3) |
| Line-end ambiguity | SMTP smuggling (Postfix, Sendmail, Exim, 2023: bare LF) | one rule for line ends; CRLF canonical form for signatures (sections 3, 5) |
| Transfer-encoding edge cases | Inbox Invasion; the MIME ambiguity Internet-Draft | fixed decoder rules; encodings on multiparts ignored (section 3) |
| Charset tricks | UTF-7 and ISO-2022 escapes hiding text from filters | WHATWG labels only; no UTF-7 (section 3) |
| Quadratic work, recursion, ReDoS | postal-mime (quadratic encoded-word join; nested multipart); Nodemailer's address parser (backtracking, recursion); Go `net/mail` and `mime/multipart` (quadratic concatenation, part counts); Perl Email-MIME | scanners without backtracking, iterative walks, one budget per call (section 4) |
| Filename spoofing and traversal | the U+202E trick; Thunderbird (a malformed filename attached a directory listing to a forward) | the filename rules (section 4) |
| Content-type confusion, attachments as documents | Roundcube [CVE-2024-42008](https://www.sonarsource.com/blog/government-emails-at-risk-critical-cross-site-scripting-vulnerability-in-roundcube-webmail/) (an attachment served with a dangerous type), CVE-2024-37383 (SVG, exploited); Thunderbird (a message declared as PDF rendered as HTML); Zimbra CVE-2025-27915 (HTML in an ICS file, exploited) | inline images by magic number, never SVG; calendar text never HTML (sections 2, 3) |
| `cid:` and Content-Location reaching across parts | [Re: What's Up Johnny?](https://arxiv.org/abs/1904.07550) (ACNS 2019: hidden content, replies as decryption oracles) | inline per body and per protection; no Content-Location (section 2) |
| Signature spoofing by wrapping and display | [Johnny, You Are Fired](https://www.usenix.org/conference/usenixsecurity19/presentation/muller) (USENIX Security 2019: most OpenPGP and S/MIME clients); Thunderbird (signed text read as headers, [MFSA 2023-55](https://www.mozilla.org/security/advisories/mfsa2023-55/)) | labels per part, strict shape, `'all'` only for one root signature by the From; signed text never re-read as headers (sections 5, 7) |
| EFAIL | [Poddebniak et al.](https://www.usenix.org/conference/usenixsecurity18/presentation/poddebniak) (USENIX Security 2018) | bodies never joined; root only; integrity required; no remote images in decrypted parts (sections 2, 5) |
| Ciphertext replay, reply oracles | Re: What's Up Johnny?; an old ciphertext re-sent as a new message's root | protected headers per their form, Reply-To from the payload, From only when signed, replies quote only on `'matches'` (sections 6, 7) |
| Unprotected headers trusted inside E2EE | [Delta Chat](https://eprint.iacr.org/2024/918.pdf) (USENIX Security 2024: a plaintext header removed a group member) | outer-only fields never protected (section 6) |
| Vendor headers and external parts acted on | Thunderbird ([MFSA 2025-26](https://www.mozilla.org/security/advisories/mfsa2025-26): an external-attachment header fetched); `message/partial` reassembly to evade scanners | opaque types, vendor headers never acted on (section 3) |

Memory-safety bugs in C parsers (mutt, PHP's mailparse) do not carry over to TypeScript and are left out.

## Settled for implementation

Choices the third review left to the implementation, recorded so that every part of it makes the same ones:

- **A sub-range of a decoded body**: `Ref` has an optional `slice: [start, end]`, offsets in the decoded bytes,
  applied after `encoding` is undone (a cleartext block inside a base64 `text/plain`).
- **Digests**: SHA-256 over the step's bytes as `mail.bytes` returns them; for `verify`, over the signed bytes'
  length as 4 bytes big-endian, then the signed bytes, then the signature. Digests are kept per input (by
  identity) and per decrypted payload, so a cache miss of `mail.mime` hashes nothing twice.
- **`mail.bytes`** throws a `TypeError` for a `Ref` outside its source, or whose `source` step has no `ok`
  plaintext in `decrypted`.
- **`summary.from`**, row 3: the signer must include the From to show; a protected From with a signer that
  matches only the outer From is `'differs'`.
- **Types**: `Attachment.disposition` is as declared (a related part may have none); `armored` is whether the
  ciphertext's bytes start with an armor line, PGP/MIME included; `integrity` is required with `status: 'ok'`
  and ignored otherwise; a `limit` problem with `part: null` (the call's byte budget) stops every step not
  yet offered.
- **Dates** are parsed with plain arithmetic, no `Date`, which is not a fold global.
- **Blocking scope**: section 3's wording ("Near crypto") is the one that counts.
- **Boundary prefixes**: a child boundary starting with an ancestor's is blocking; to be measured against the
  corpus in step 1, and relaxed if real generators do it.

## Decisions

1. **Our own MIME reader**, after measuring the existing ones; their corpora and fixtures are borrowed
   ([Our own reader or a dependency](#our-own-reader-or-a-dependency)).
2. **No cryptography in the library.** Keys, decryption, verification and trust are the app's (openpgp.js
   in a `data-sn-call` action, a server, a hardware key); the library lists steps and reads results. Its one
   hash, SHA-256, binds results to bytes and proves nothing else.
3. **One pure call, no bytes in the result, results bound to bytes.** Results go in as options, keyed by ids
   that carry a digest; bytes come out through `mail.bytes`.
4. **Only the root is decrypted on its own**, and the app must vouch for integrity. Other encrypted entities
   are one part the reader may open, shown in place and never counted as the message's.
5. **Signatures anywhere shown, labels per part.** A verdict covers its part's subtree and nothing else;
   `'all'` needs one signature over the root by the From.
6. **Inline PGP only as the only body** for decryption on its own; cleartext signatures only line-anchored,
   unquoted, with only `Hash:` headers and dash-escaped lines, splitting the body.
7. **Protected headers per their form, From only when signed.** With `hp`, the payload's whole set; with
   `protected-headers="v1"`, field by field, Reply-To only from the payload; `sources` says which is which.
8. **Detection is structural, and strict near crypto.** Text that looks like armor in a quote, a forward or
   HTML is text; a blocking problem in or above a cryptographic structure means no step; informational
   problems never do.
9. **The steps are protocol-shaped, not PGP-shaped**, so S/MIME (`application/pkcs7-mime`,
   `multipart/signed; protocol="application/pkcs7-signature"`) can add step kinds without changing the
   message.
10. **Decoding never creates structure.** Encoded words are decoded after tokenizing, controls are removed,
    inline images stay with their body and its protection.

## Plan

0. Done: RFC 9788 read in full (the RFC Editor's final XML from the authors' repository), the Autocrypt
   protected-headers draft, and the payloads of "Splitting the email atom"; section 6 and the header rules of
   section 3 follow them.
1. The reader: headers, addresses, dates, encodings, structure, limits, problems, ids, `mail.bytes`,
   `mail.imageType`, SHA-256. Tests: Stalwart's corpus and jsmime's charset set (licenses permitting, with
   attribution), real messages (with consent, anonymized), hostile ones (nesting, boundaries, encodings, the
   inputs of other parsers' advisories), and the known attacks
   ([Pitfalls](#pitfalls-from-other-mime-parsers)); a fuzzer comparing our reader with Stalwart's on
   structure, as the HTML parser is compared with parse5.
2. What to show: alternatives, related, mixed, digests, reports, attachments, inline, calendar, nested
   messages; the `mail.parse` and `mail.plain` hand-off, and `mail.parse`'s new options.
3. Steps and results, tested with openpgp.js in the tests only (a dev dependency): messages from Thunderbird,
   Mailvelope, Proton, K-9/FairEmail, Delta Chat, Apple Mail with GPG Suite, and openpgp.js-based web
   composers; Exchange's rewrite; the published attacks (EFAIL, signature spoofing, re-wrapped ciphertexts,
   stale results).
4. Protected headers, legacy display, the summary.
5. The guide (a section in `docs/mail.md`, a recipe: a reader with decrypt, badges and attachments, the action
   of section 1) and `llms.txt`.
6. A first app moves over ([For apps](#for-apps)).

## For apps

What an app with its own MIME and PGP handling changes to move over:

- **The reader renders from `mail.mime`** on the raw message, held in state; the app's own MIME parsing
  goes; its decrypt and verify functions become an action that runs the pending steps and stores a
  `Decrypted` or `Verdict[]` by step id (section 1). Decrypt must report `integrity` honestly; verify must
  return only user IDs the app trusts as `signer`.
- **Results are per message.** Step ids carry a digest, so results from another message are ignored; an app
  may still keep them per message, and should drop them when the reader closes it.
- **A server's encrypted and signed flags become hints**: they can keep choosing whether to fetch the raw
  message; the badges come from `summary` and each part's `protection`. A server-side parser can stay for
  search and the list; a disagreement then changes what is found, not what is shown as verified.
- **Badges follow the summary**: a message-level badge only for `'all'`, per-part marks otherwise, a warning
  when `from` is `'differs'` or `'unknown'` on decrypted content, and an opened part shown as its own block.
- **Images in decrypted parts** load only after the reader's consent for that message (`consent: true`).
- **Replies**: address them to `reply`; quote decrypted content only when `from` is `'matches'` (or after
  asking); in an unencrypted reply, use the `HP-Outer` (or, under v1, outer) value of the `confidential`
  headers, and leave out those that have none.
- **The list**: encrypted subjects stay `...` until opened unless the browser keeps decrypted headers; that
  is the app's choice.

## Open questions

- **Inbox Invasion** (CCS 2024), the measurement paper behind the MIME ambiguity draft, could not be fetched;
  its classes are known from the draft's summary.
- **Signed but not encrypted, with protected headers**: a good signature's inner Subject wins (section 6).
  Is a differing outer Subject worth a problem of its own?
- **`prefer`**: whether an app needs more than `'html' | 'text'`.
- **Size**: whether 12 kB holds with the address and date grammars and SHA-256.
