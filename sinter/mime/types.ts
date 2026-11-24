// The types of `mail.mime`'s message (docs/proposals/sinter-mail-mime.md, sections 1, 2, 5 and 7). Plain data
// only: no bytes (they come out through `mail.bytes`), no maps keyed by the sender's strings, JSON-shaped, so a
// message can be frozen, cloned, sent from a server and folded at build time.

export interface MimeOptions {
  /** in multipart/alternative, between an HTML and a text candidate; default 'html' */
  prefer?: 'html' | 'text';
  /** results of decrypt steps, by step id */
  decrypted?: Record<string, Decrypted>;
  /** results of verify steps, by step id */
  verdicts?: Record<string, Verdict[]>;
  /** step ids of encrypted parts the reader chose to open (section 5) */
  open?: string[];
}

export interface BytesOptions {
  decrypted?: Record<string, Decrypted>;
}

export interface Message {
  type: 'message';
  /** the headers to show (section 6) */
  headers: Headers;
  /** the headers as transported */
  outer: Headers;
  /** where each shown field came from */
  sources: Sources;
  /** whom a reply goes to (section 6) */
  reply: Address[];
  /** header names the sender sent only encrypted, lowercase */
  confidential: string[];
  /** the payload root's HP-Outer fields (RFC 9788), name lowercased and value as given: what the outer header said
   * (or that it was absent), for a confidential field in an unencrypted reply; only with hp="cipher" in a done root
   * decrypt, else empty */
  hpOuter: [name: string, value: string][];
  /** what to show, in reading order */
  parts: Part[];
  attachments: Attachment[];
  /** text/calendar parts (iMIP), as text */
  calendar: Calendar[];
  /** what the app is asked to do; empty for plain mail */
  steps: Step[];
  summary: Summary;
  /** what was malformed, refused or repaired; never content */
  problems: Problem[];
}

interface PartBase {
  /** the entity's path (`1.2.1`; in a payload, `<step id>/1.2`; split around cleartext blocks, `<id>:n`). A nested
   * message's entity and its multipart root share one id (IMAP's numbering): the message part has it, and that root,
   * when shown whole (an encrypted part, or an attachment of its bytes), is `<id>.1`. No two parts or attachments of
   * a message, nested ones included, have the same id */
  id: string;
  contentType: string;
  protection: Protection;
}

export type Part =
  | (PartBase & { type: 'html'; html: string; legacyDisplay: boolean; inline: Inline[] })
  | (PartBase & { type: 'text'; text: string; flowed: boolean; delsp: boolean })
  | (PartBase & { type: 'message'; message: Message; ref: Ref })
  | (PartBase & { type: 'encrypted'; ref: Ref; step: string; reason: EncryptedReason })
  | (PartBase & { type: 'report'; text: string });

export type EncryptedReason = 'pending' | 'failed' | 'not-root' | 'over-limit';

export interface Headers {
  subject: string | null;
  from: Address[];
  sender: Address[];
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  /** ISO 8601 with the sender's offset; null when unparseable */
  date: string | null;
  messageId: string | null;
  inReplyTo: string[];
  references: string[];
  /** List-Id, List-Unsubscribe, List-Unsubscribe-Post */
  list: [name: string, value: string][];
  /** Autocrypt headers, unfolded */
  autocrypt: string[];
  /** every header, unfolded, not decoded */
  raw: [name: string, value: string][];
}

export type Field = 'subject' | 'from' | 'sender' | 'replyTo' | 'to' | 'cc' | 'date' | 'messageId' | 'inReplyTo' | 'references';
export type Sources = { [F in Field]: 'protected' | 'outer' };

export interface Address {
  name: string | null;
  /** null when the addr-spec is ambiguous or malformed: never a guess */
  address: string | null;
  /** the group's name; an empty group is one Address with name and address null */
  group?: string;
  /** read one way, but other software may read it another: a display name that looks like an address and is not
   * this one; a source route; the percent hack or a UUCP path (`%`, `!`) in the local part; a quoted local part with
   * `@`; an encoded word in the local part; a domain literal */
  suspicious?: true;
}

export interface Ref {
  /** 'input', or the id of the decrypt step whose plaintext holds it */
  source: string;
  /** byte offsets in that source */
  start: number;
  end: number;
  /** what mail.bytes undoes */
  encoding: 'base64' | 'quoted-printable' | 'identity';
  /** mail.bytes also converts bare LF to CRLF */
  canonical?: true;
  /** offsets in the decoded bytes, applied after `encoding` is undone */
  slice?: [number, number];
}

export type AttachmentKind = 'file' | 'related' | 'calendar' | 'message' | 'pgp-keys' | 'encrypted';

export interface Attachment {
  id: string;
  /** made safe (section 4) */
  filename: string;
  /** as decoded, controls removed; for display only, never for saving */
  originalFilename: string | null;
  /** as declared, lowercased; not trusted */
  contentType: string;
  disposition: 'attachment' | 'inline' | null;
  kind: AttachmentKind;
  contentId: string | null;
  /** decoded */
  size: number;
  ref: Ref;
  protection: Protection;
}

export interface Inline { contentId: string; attachment: string }

export interface Calendar { part: string; method: string | null; text: string; attachment: string }

export type ProblemCode =
  // blocking
  | 'boundary-missing-close' | 'boundary-invalid' | 'duplicate-field' | 'duplicate-parameter'
  | 'encoding-on-multipart' | 'encoding-unknown' | 'crypto-shape' | 'limit' | 'integrity'
  | 'control-in-structure' | 'parameter-conflict' | 'header-malformed' | 'content-type-invalid'
  | 'parameter-malformed'
  // informational
  | 'armor-headers' | 'no-header-end' | 'duplicate-header' | 'canonicalized' | 'exchange-shape' | 'charset-unknown'
  | 'charset-fallback' | 'base64-junk' | 'qp-invalid' | 'rfc2231-segments' | 'content-id-duplicate'
  | 'field-dropped' | 'stale-result' | 'address-ambiguous' | 'legacy-display' | 'encoded-word-in-parameter';

export interface Problem {
  code: ProblemCode;
  /** the entity or part it concerns, by its path; a nested message's entity and its multipart root share one id
   * (their problems are listed together), or null for the whole call */
  part: string | null;
  /** whether it stops steps */
  blocking: boolean;
}

interface StepBase { id: string; state: 'pending' | 'done' | 'failed'; part: string }

export type Step =
  | (StepBase & { kind: 'decrypt'; ciphertext: Ref; armored: boolean })
  | (StepBase & { kind: 'verify'; signed: Ref; signature: Ref; micalg: string | null })
  | (StepBase & { kind: 'verify-cleartext'; block: Ref; charset: string });

export interface Decrypted {
  status: 'ok' | 'failed' | 'no-key' | 'locked' | 'unsupported';
  /** with 'ok' */
  plaintext?: Uint8Array;
  /** the app checked an integrity-protected packet decrypted completely, and that it was an encrypted message;
   * required with 'ok' (anything but true refuses the plaintext) */
  integrity?: boolean;
  /** signatures inside the ciphertext */
  signatures?: Verdict[];
}

export interface Verdict {
  status: 'good' | 'bad' | 'no-key' | 'expired' | 'revoked' | 'unsupported';
  fingerprint?: string;
  created?: string;
  /** addresses of the key's user IDs that the app trusts as the key's */
  signer?: string[];
}

export interface Protection {
  encrypted: boolean;
  opened?: true;
  signed: Verdict['status'] | 'pending' | null;
  step?: string;
  signer?: string[];
}

export interface Summary {
  encrypted: 'all' | 'some' | 'none';
  signed: 'all' | 'some' | 'none';
  from: 'matches' | 'differs' | 'unknown' | null;
}

export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif';
