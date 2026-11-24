// Writes the hostile .eml fixtures of this directory and manifest.json:  node test/mime-corpus/hostile/build.mjs
// Deterministic; the inputs are taken from the advisories and fix commits cited in the manifest.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url)) + '/';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const base = (from, extra = '') =>
  `From: ${from}\r\nTo: reader@example.test\r\n${extra}Subject: hostile fixture\r\nDate: Tue, 24 Nov 2026 09:30:00 +0100\r\nMessage-ID: <hostile@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n`;
const w = (name, s) => writeFileSync(dir + name + '.eml', Buffer.from(s, 'latin1'));

// postal-mime 4.2.1, commit 6467257 (header-parsing-test.ts): CFWS beside a dot of the domain
w('postal-mime-domain-cfws', base('ceo@victim.example .evil.example',
  'Cc: ceo@victim.example(x).evil.example, CEO <ceo@victim.example .evil.example>, CEO <ceo@victim.example(x).evil.example>\r\n'));
// postal-mime 4.2.1 (address-parser-test.ts): control character inside an addr-spec
w('postal-mime-addr-spec-control', base('CEO <ceo@vic\x01tim.example>',
  'Cc: ceo@victim.example\x0b.evil.example, x <a@b.example>, ceo@vic\x01tim.example, y <c@d.example>\r\n'));
// postal-mime 4.1.1 e06badb (address-parser-test.ts): encoded words that decode to address syntax
w('postal-mime-encoded-angle-addr', base(`=?utf-8?B?${b64('Name <a@b.c>')}?=`,
  `Cc: (=?utf-8?B?PGV2aWxAZXZpbC5jb20+?=), <(=?utf-8?B?PGV2aWxAZXZpbC5jb20+?=)>\r\nReply-To: =?UTF-8?Q?John_Smith_(?= <ceo@company.example> =?UTF-8?Q?)?= <a@evil.example>\r\n`));
// nodemailer 7.0.7, GHSA-mm7p-fcc7-pg87 / CVE-2025-13033, commit 1150d99: quoted local part holding '@'
w('nodemailer-quoted-local-part', base('"xclow3n@gmail.com x"@internal.domain',
  'Cc: "user@attacker.com"@legitimate.com, "a@b@c"@example.com\r\n'));
// nodemailer addressparser test: escaped parenthesis inside a comment
w('nodemailer-comment-escaped-paren', base('(x\\) <b@evil.example>) Victim <a@victim.example>'));
// nodemailer addressparser ReDoS test: many '@'
w('nodemailer-many-at', base('@'.repeat(100)));
// Python CVE-2023-27043, cpython gh-102988: alice@example.org + special + <bob@example.org>
const specials = { 'paren-open': '(', 'paren-close': ')', lt: '<', gt: '>', at: '@', comma: ',', colon: ':', semicolon: ';', dot: '.', dquote: '"', 'bracket-open': '[', 'bracket-close': ']' };
for (const [n, c] of Object.entries(specials)) w(`python-cve-2023-27043-${n}`, base(`alice@example.org${c}<bob@example.org>`));
// Amavis CVE-2024-28054: two boundary parameters
const two = (ct) => `From: sender@example.test\r\nTo: reader@example.test\r\nSubject: two boundaries\r\nMIME-Version: 1.0\r\n${ct}\r\n\r\n` +
  `--aaa\r\nContent-Type: text/plain\r\n\r\nharmless text, the reading by the first boundary\r\n` +
  `--bbb\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="payload.exe"\r\nContent-Transfer-Encoding: base64\r\n\r\nTVqQAAMAAAAEAAAA//8AALgAAAAAAAAAQAAAAA==\r\n` +
  `--bbb--\r\n--aaa--\r\n`;
w('amavis-cve-2024-28054-duplicate-boundary', two('Content-Type: multipart/mixed; boundary="aaa"; boundary="bbb"'));
w('duplicate-content-type', two('Content-Type: multipart/mixed; boundary="aaa"\r\nContent-Type: multipart/mixed; boundary="bbb"'));
// Mailsploit (2017): encoded NUL and '@' (local part of encoded words, and an encoded display name)
w('mailsploit-local-part', base(`=?utf-8?b?${b64('potus@whitehouse.gov')}?==?utf-8?Q?=00?==?utf-8?b?${b64('(potus@whitehouse.gov)')}?=@mailsploit.com`));
w('mailsploit-display-name', base(`=?utf-8?b?${b64('potus@whitehouse.gov <potus@whitehouse.gov>')}?= =?utf-8?Q?=0A=00?= <attacker@mailsploit.com>`));
// Splitting the email atom (Heyes 2024): encoded '@' '>' NUL in the local part; UTF-7 in an encoded word
w('splitting-atom-local-part', base('=?x?q?collab=40psres.net=3e=00?=foo@example.com',
  'Cc: =?utf-7?q?&AEA-psres.net&AD4-?=@example.com, "=?utf-8?q?ceo=40bank.example_=3cceo=40bank.example=3e?=" <attacker@evil.example>\r\n'));
// Header injection through a decoded value (CVE-2024-6923 class): encoded CRLF in Subject and a filename
w('encoded-crlf-injection',
  `From: sender@example.test\r\nTo: reader@example.test\r\nSubject: =?utf-8?Q?hello=0D=0ABcc:_victim@example.test?=\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n` +
  `--b\r\nContent-Type: text/plain\r\n\r\ntext\r\n` +
  `--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="=?utf-8?Q?a=0D=0AX-Evil:_1=E2=80=AEtxt.exe?="\r\n\r\nx\r\n--b--\r\n`);
// Thunderbird MFSA 2023-55 (reconstructed): signed text that looks like header fields
w('signed-text-as-headers-pgpmime',
  `From: Mallory <mallory@evil.example>\r\nTo: reader@example.test\r\nSubject: fwd\r\nMIME-Version: 1.0\r\nContent-Type: multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="s"\r\n\r\n` +
  `--s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nFrom: CEO <ceo@bank.example>\r\nSubject: Approved: wire the money\r\nDate: Tue, 24 Nov 2026 09:00:00 +0100\r\n\r\nPlease wire it today.\r\n` +
  `--s\r\nContent-Type: application/pgp-signature; name="signature.asc"\r\n\r\n-----BEGIN PGP SIGNATURE-----\r\n\r\niHUEARYKAB0WIQplaceholder\r\n=AAAA\r\n-----END PGP SIGNATURE-----\r\n\r\n--s--\r\n`);
w('signed-text-as-headers-cleartext',
  `From: Mallory <mallory@evil.example>\r\nTo: reader@example.test\r\nSubject: fwd\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n` +
  `-----BEGIN PGP SIGNED MESSAGE-----\r\nHash: SHA256\r\n\r\nFrom: CEO <ceo@bank.example>\r\nSubject: Approved: wire the money\r\n\r\nPlease wire it today.\r\n-----BEGIN PGP SIGNATURE-----\r\n\r\niHUEARYKAB0WIQplaceholder\r\n=AAAA\r\n-----END PGP SIGNATURE-----\r\n`);

// --- manifest ---

const PM = 'https://github.com/postalsys/postal-mime';
const NM = 'https://github.com/nodemailer/nodemailer';
const T = 1000; // ms, small inputs
const TL = 5000; // ms, the generated large inputs (postal-mime's own bound)
const fixtures = [
  {
    name: 'postal-mime-domain-cfws', file: 'postal-mime-domain-cfws.eml',
    source: [`${PM}/commit/646725704463839f233472453b7c8306bd1dde21`, `${PM}/blob/master/test/header-parsing-test.ts`, 'https://www.vulncheck.com/advisories/postal-mime-before-4.2.1-sender-spoofing-via-address-parser-domain-truncation'],
    attacks: 'address parser domain truncation (postal-mime < 4.2.1): CFWS beside a dot ended the domain, so ceo@victim.example .evil.example read as ceo@victim.example',
    expected: {
      outcome: 'every address is ceo@victim.example.evil.example (obs-domain allows CFWS around dots) or null; never ceo@victim.example',
      addresses: { fields: ['from', 'cc'], oneOf: ['ceo@victim.example.evil.example', null], never: ['ceo@victim.example'] },
      timeBoundMs: T, proposal: 'section 3, Headers (RFC 5322 grammar with its obsolete forms; address: null rather than a guess)',
    },
  },
  {
    name: 'postal-mime-addr-spec-control', file: 'postal-mime-addr-spec-control.eml',
    source: [`${PM}/blob/master/test/address-parser-test.ts`, `${PM}/commit/646725704463839f233472453b7c8306bd1dde21`],
    attacks: 'a control character inside an addr-spec: dropping it silently reads ceo@victim.example, a domain the sender never authenticated for',
    expected: {
      outcome: "From is { name: 'CEO', address: null } and summary.from is 'unknown'; in Cc, x <a@b.example> and y <c@d.example> are read, the two with control characters are address: null",
      addresses: { fields: ['from', 'cc'], never: ['ceo@victim.example', 'ceo@victim.example.evil.example'], includes: ['a@b.example', 'c@d.example'] },
      summaryFrom: 'unknown', timeBoundMs: T, proposal: 'section 3, Headers',
    },
  },
  {
    name: 'postal-mime-encoded-angle-addr', file: 'postal-mime-encoded-angle-addr.eml',
    source: [`${PM}/commit/e06badb`, `${PM}/blob/master/test/address-parser-test.ts`],
    attacks: 'encoded words that decode to <addr> in a display name or a comment, read again as an address',
    expected: {
      outcome: "From is { name: 'Name <a@b.c>', address: null, suspicious: true }; the Cc comments name no mailbox (evil@evil.com never an address); Reply-To's address is a@evil.example with the decoded parentheses as name text, never ceo@company.example",
      addresses: { fields: ['from', 'cc', 'replyTo'], never: ['a@b.c', 'evil@evil.com', 'ceo@company.example'] },
      suspicious: { from: true }, timeBoundMs: T, proposal: 'section 3, Headers (tokenize first, decode after; suspicious); Decisions 10',
    },
  },
  {
    name: 'nodemailer-quoted-local-part', file: 'nodemailer-quoted-local-part.eml',
    source: ['https://github.com/advisories/GHSA-mm7p-fcc7-pg87', `${NM}/commit/1150d99fba77280df2cfb1885c43df23109a8626`, `${NM}/blob/master/test/addressparser/addressparser-test.ts`],
    attacks: 'CVE-2025-13033: an @ inside a quoted local part taken as the address ("xclow3n@gmail.com x"@internal.domain routed to gmail.com)',
    expected: {
      outcome: 'each address keeps its real domain (internal.domain, legitimate.com, example.com) with the quoted local part, or is null; never the address inside the quotes',
      addresses: { fields: ['from', 'cc'], domainOneOf: ['internal.domain', 'legitimate.com', 'example.com'], never: ['xclow3n@gmail.com', 'user@attacker.com', 'a@b'] },
      timeBoundMs: T, proposal: 'section 3, Headers (RFC 5322 grammar)',
    },
  },
  {
    name: 'nodemailer-comment-escaped-paren', file: 'nodemailer-comment-escaped-paren.eml',
    source: [`${NM}/blob/master/test/addressparser/addressparser-test.ts`, `${PM}/blob/master/test/address-parser-nodemailer-test.ts`],
    attacks: 'an escaped parenthesis ending a comment early, so <b@evil.example> inside the comment became the sender',
    expected: {
      outcome: "From is { name: 'Victim', address: 'a@victim.example' }",
      addresses: { fields: ['from'], exactly: ['a@victim.example'], never: ['b@evil.example'] },
      timeBoundMs: T, proposal: 'section 3, Headers (comments nested at most 8 deep, quoted-pair)',
    },
  },
  {
    name: 'nodemailer-many-at', file: 'nodemailer-many-at.eml',
    source: [`${NM}/blob/master/test/addressparser/addressparser-test.ts`],
    attacks: "addressparser backtracking on pathological input ('@' x 100)",
    expected: { outcome: "From has no address (address: null); summary.from 'unknown'; finishes fast", summaryFrom: 'unknown', timeBoundMs: T, proposal: 'section 4, No backtracking regular expressions' },
  },
  ...Object.entries(specials).map(([n, c]) => ({
    name: `python-cve-2023-27043-${n}`, file: `python-cve-2023-27043-${n}.eml`,
    source: ['https://github.com/python/cpython/issues/102988', 'https://access.redhat.com/articles/7051467'],
    attacks: `CVE-2023-27043: email.utils.parseaddr read 'alice@example.org${c}<bob@example.org>' as one address, alice@example.org`,
    expected: c === ','
      ? { outcome: 'a list of two mailboxes: alice@example.org and bob@example.org (From with two authors)', addresses: { fields: ['from'], exactly: ['alice@example.org', 'bob@example.org'] }, timeBoundMs: T, proposal: 'section 3, Headers' }
      : { outcome: "the grammar cannot read it: every From address is null, summary.from 'unknown'; never alice@example.org alone", addresses: { fields: ['from'], oneOf: [null] }, summaryFrom: 'unknown', timeBoundMs: T, proposal: 'section 3, Headers (an addr-spec the grammar cannot read one way only is address: null)' },
  })),
  {
    name: 'amavis-cve-2024-28054-duplicate-boundary', file: 'amavis-cve-2024-28054-duplicate-boundary.eml',
    source: ['https://gitlab.com/amavis/amavis/-/work_items/112'],
    attacks: 'CVE-2024-28054: two boundary parameters; the scanner used one, the client the other, so the attachment went unscanned',
    expected: {
      outcome: 'the first boundary counts (aaa): the root has one text/plain part whose body holds the --bbb lines as text; duplicate-parameter, blocking: no step in or below the root',
      problems: ['duplicate-parameter'], blocking: true, noSteps: true,
      tree: { type: 'multipart/mixed', parts: [{ type: 'text/plain' }] },
      timeBoundMs: T, proposal: 'section 3, Duplicates and conflicts; section 2, problem table',
    },
  },
  {
    name: 'duplicate-content-type', file: 'duplicate-content-type.eml',
    source: ['https://www.usenix.org/conference/usenixsecurity20/presentation/chen-jianjun', 'https://citation.thinkst.com/talk/96163'],
    attacks: 'two Content-Type fields with different boundaries (the same differential through a repeated field)',
    expected: { outcome: 'the first field counts (boundary aaa), as above; duplicate-field, blocking', problems: ['duplicate-field'], blocking: true, noSteps: true, tree: { type: 'multipart/mixed', parts: [{ type: 'text/plain' }] }, timeBoundMs: T, proposal: 'section 3, Duplicates and conflicts' },
  },
  {
    name: 'mailsploit-local-part', file: 'mailsploit-local-part.eml',
    source: ['https://www.mailsploit.com/index'],
    attacks: 'Mailsploit (2017): encoded words with an encoded NUL in the local part, decoded by clients into potus@whitehouse.gov',
    expected: {
      outcome: 'encoded words are never decoded in an addr-spec: the address is the literal local part @mailsploit.com (or null), never potus@whitehouse.gov; no NUL in any value',
      addresses: { fields: ['from'], domainOneOf: ['mailsploit.com'], never: ['potus@whitehouse.gov'] }, noControls: true,
      timeBoundMs: T, proposal: 'section 3, Headers (tokenized first, encoded words decoded only in phrases)',
    },
  },
  {
    name: 'mailsploit-display-name', file: 'mailsploit-display-name.eml',
    source: ['https://www.mailsploit.com/index'],
    attacks: 'Mailsploit: a display name that decodes to an address, then an encoded LF and NUL to hide the real address',
    expected: {
      outcome: "address attacker@mailsploit.com; name 'potus@whitehouse.gov <potus@whitehouse.gov>' with LF and NUL removed; suspicious: true",
      addresses: { fields: ['from'], exactly: ['attacker@mailsploit.com'] }, suspicious: { from: true }, noControls: true,
      timeBoundMs: T, proposal: 'section 3, Headers (controls removed; suspicious)',
    },
  },
  {
    name: 'splitting-atom-local-part', file: 'splitting-atom-local-part.eml',
    source: ['https://portswigger.net/kb/papers/rclapqr/splitting-the-email-atom.pdf'],
    attacks: "Splitting the email atom (Heyes 2024): encoded '@', '>' and NUL, and UTF-7 inside encoded words in the local part; an encoded address inside a quoted display name (Outlook-style)",
    expected: {
      outcome: "From's address has domain example.com (literal local part) or is null, never collab@psres.net; the UTF-7 Cc likewise; the quoted Cc display name decodes to 'ceo@bank.example <ceo@bank.example>' with address attacker@evil.example and suspicious: true",
      addresses: { fields: ['from', 'cc'], never: ['collab@psres.net', 'ceo@bank.example'] }, suspicious: { cc: true }, noControls: true,
      timeBoundMs: T, proposal: 'section 3, Headers; Charsets (no UTF-7)',
    },
  },
  {
    name: 'encoded-crlf-injection', file: 'encoded-crlf-injection.eml',
    source: ['https://openwall.com/lists/oss-security/2024/08/01/3'],
    attacks: 'header injection through decoded values (CVE-2024-6923 class): an encoded CRLF in Subject and in a filename, plus U+202E',
    expected: {
      outcome: "Subject 'helloBcc: victim@example.test' (CR and LF removed); the attachment's filename has no CR, LF, ':' or U+202E; originalFilename has no CR or LF",
      noControls: true, timeBoundMs: T, proposal: 'section 3, Headers (controls removed); section 4, Filenames',
    },
  },
  {
    name: 'signed-text-as-headers-pgpmime', file: 'signed-text-as-headers-pgpmime.eml',
    source: ['https://www.mozilla.org/security/advisories/mfsa2023-55/'],
    reconstructed: 'from the proposal\'s description of MFSA 2023-55 (signed text read as headers); the advisory text was not reachable from this environment',
    attacks: 'signed body text that looks like header fields, shown by a client as the signed message\'s headers',
    expected: {
      outcome: "a verify step for the root; the From/Subject/Date lines are the signed part's text, never headers: headers.from is Mallory's, subject 'fwd'; no protected headers apply (no protected-headers form)",
      steps: ['verify'], headersFrom: 'mallory@evil.example', subject: 'fwd',
      timeBoundMs: T, proposal: 'section 5, PGP/MIME signed (the signed part\'s text is never re-read as headers); section 6',
    },
  },
  {
    name: 'signed-text-as-headers-cleartext', file: 'signed-text-as-headers-cleartext.eml',
    source: ['https://www.mozilla.org/security/advisories/mfsa2023-55/'],
    reconstructed: 'as above, for an inline cleartext-signed block',
    attacks: 'the same with inline PGP: the signed text starts with header-like lines',
    expected: {
      outcome: "a verify-cleartext step for the block; the lines are text of the signed part; headers.from is Mallory's",
      steps: ['verify-cleartext'], headersFrom: 'mallory@evil.example', subject: 'fwd',
      timeBoundMs: T, proposal: 'section 5, Inline PGP',
    },
  },
];

const generated = [
  {
    name: 'postal-mime-encoded-word-join', generator: 'manyEncodedWords',
    source: ['https://github.com/advisories/GHSA-f2hq-32vh-53cc', `${PM}/commit/9eb25a66bb3cc8b631421be651b9648796f19136`, `${PM}/blob/master/test/parse-cost-test.ts`],
    attacks: 'GHSA-f2hq-32vh-53cc: quadratic joining of 99,000+ adjacent base64 encoded words (=?utf-8?B?QUJD?=) in one Subject',
    expected: {
      outcome: "linear: the header block (about 1.9 MB) passes the root's 1 MB limit and the field its 4,096 encoded words; what came before is kept, the rest dropped: subject is null (the field runs past the limit) or 'ABC' repeated at most 4,096 times; field-dropped",
      problems: ['field-dropped'], timeBoundMs: TL, proposal: 'section 4, Bounded work and Past a limit; section 3, encoded words joined per charset and decoded once',
    },
  },
  {
    name: 'postal-mime-encoded-word-join-under-header-limit', generator: 'manyEncodedWordsUnderHeaderLimit',
    source: ['https://github.com/advisories/GHSA-f2hq-32vh-53cc'],
    attacks: 'the same with 50,000 words (about 0.9 MB), inside the header block limit, so only the 4,096-words-per-field limit is met',
    expected: { outcome: "subject is 'ABC' repeated exactly 4,096 times (the words before the limit, joined); field-dropped", problems: ['field-dropped'], subject: 'ABC'.repeat(4096), timeBoundMs: TL, proposal: 'section 4, Bounded work and Past a limit' },
  },
  {
    name: 'postal-mime-encoded-word-join-invalid', generator: 'manyInvalidEncodedWords',
    source: [`${PM}/blob/master/test/parse-cost-test.ts`],
    attacks: 'the same with words decoding to invalid UTF-8, which made postal-mime render the header a second time',
    expected: { outcome: 'linear; the joined run is invalid UTF-8, so windows-1252: each 0x80 is €; field-dropped and charset-fallback', problems: ['field-dropped', 'charset-fallback'], timeBoundMs: TL, proposal: 'sections 3 and 4' },
  },
  {
    name: 'postal-mime-boundary-near-miss', generator: 'postalMimeBoundaryNearMiss',
    source: [`${PM}/commit/3c3fd9e72eeb0008bab3c8582c54a89966d84df7`, `${PM}/blob/master/test/parse-cost-test.ts`],
    attacks: 'boundary matching DoS (postal-mime < 4.2.1): 250 open boundaries and 16,000 lines that start like every one of them',
    expected: {
      outcome: 'boundaries found in one pass; B…B10 starts with ancestor B…B1, so boundary-invalid; nesting past 32 is one attachment with a limit problem; never throws',
      problems: ['boundary-invalid', 'limit'], timeBoundMs: TL, proposal: 'section 3, Boundaries; section 4, Bounded work',
    },
  },
  {
    name: 'postal-mime-many-addresses', generator: 'postalMimeManyAddresses',
    source: [`${PM}/blob/master/test/parse-cost-test.ts`, `${PM}/issues/97`],
    attacks: 'quadratic address list parsing (150,000 addresses in To)',
    expected: { outcome: 'at most 1,000 addresses in to, the rest dropped (field-dropped); linear', problems: ['field-dropped'], maxAddresses: 1000, timeBoundMs: TL, proposal: 'section 3 (at most 1,000 addresses per field); section 4' },
  },
  {
    name: 'nodemailer-deep-groups', generator: 'nodemailerDeepGroups',
    source: [`${NM}/commit/b61b9c0cfd682b6f647754ca338373b68336a150`, `${NM}/blob/master/test/addressparser/addressparser-test.ts`],
    attacks: 'stack overflow in addressparser from 3,000 nested groups (g0: g1: … user@example.com;)',
    expected: { outcome: 'read iteratively, never throws; groups do not nest in RFC 5322, so the value is read by the grammar one way or is address: null; time bound', timeBoundMs: TL, proposal: 'section 3, Headers (iteratively); section 4' },
  },
  {
    name: 'nodemailer-group-openers', generator: 'nodemailerGroupOpeners',
    source: [`${NM}/commit/a951c808c6176d4eea81ee85c232148e61f1ee4b`, `${NM}/blob/master/test/addressparser/addressparser-test.ts`],
    attacks: "each group opener re-parsed the rest of the value: 'g: ' x 100,000 then 60,000 addresses (80,000 in its test)",
    expected: { outcome: 'linear; at most 1,000 addresses (field-dropped); never throws', problems: ['field-dropped'], maxAddresses: 1000, timeBoundMs: TL, proposal: 'sections 3 and 4' },
  },
  { name: 'single-part-2mb', generator: 'singlePart', source: [], attacks: 'one 2 MB part (emailjs-mime-parser overflowed fromCharCode.apply)', expected: { outcome: 'read whole: one text/plain part of 2 MiB; no problem', noProblems: true, timeBoundMs: TL, proposal: 'section 4; Our own reader, What to avoid' } },
  { name: 'many-parts-20000', generator: 'manyParts', source: [], attacks: '20,000 parts (jsmimeparser recursion overflow; postal-mime part counts)', expected: { outcome: 'the first parts up to the 1,000-part limit, then the entity past the limit as one attachment with its bytes; limit', problems: ['limit'], timeBoundMs: TL, proposal: 'section 4, Past a limit' } },
  { name: 'deep-nesting-300', generator: 'deepNesting', source: [], attacks: 'nesting 300 deep (recursive walks)', expected: { outcome: 'walked without recursion; past 32 levels one attachment with a limit problem; never throws', problems: ['limit'], timeBoundMs: TL, proposal: 'section 4' } },
  { name: 'oversized-header-2mb', generator: 'oversizedHeader', source: [], attacks: 'a 2 MB root header block', expected: { outcome: 'the fields within the first 1 MB are kept (From, To, X-Pad…), the rest dropped (field-dropped): subject null, and the Content-Type past the limit is dropped too, so the body reads as text/plain', problems: ['field-dropped'], subject: null, timeBoundMs: TL, proposal: 'section 4, Bounded work and Past a limit' } },
  { name: 'boundary-prefix-of-parent', generator: 'boundaryPrefixOfParent', source: [], attacks: 'a child boundary (abc) that is a prefix of its parent\'s (abcdef): prefix matching splits the parent at the child\'s delimiters', expected: { outcome: 'read exactly: multipart/mixed [multipart/alternative [text/plain, text/html], text/plain attachment]; no problem', noProblems: true, tree: { type: 'multipart/mixed', parts: [{ type: 'multipart/alternative', parts: [{ type: 'text/plain' }, { type: 'text/html' }] }, { type: 'text/plain' }] }, timeBoundMs: T, proposal: 'section 3, Boundaries' } },
  { name: 'boundary-extends-parent', generator: 'boundaryExtendsParent', source: ['https://citation.thinkst.com/talk/96163'], attacks: 'a child boundary (abc-inner) that starts with its parent\'s (abc)', expected: { outcome: 'boundary-invalid (blocking)', problems: ['boundary-invalid'], blocking: true, timeBoundMs: T, proposal: 'section 3, Boundaries; Settled for implementation, Boundary prefixes' } },
  { name: 'missing-close-boundary', generator: 'missingCloseBoundary', source: [], attacks: 'no close delimiters, inner and outer', expected: { outcome: 'multipart/mixed [multipart/alternative [text/plain, text/html], text/plain]: the inner ends at the outer delimiter, the outer at the end of the input; boundary-missing-close for both', problems: ['boundary-missing-close'], tree: { type: 'multipart/mixed', parts: [{ type: 'multipart/alternative', parts: [{ type: 'text/plain' }, { type: 'text/html' }] }, { type: 'text/plain' }] }, timeBoundMs: T, proposal: 'section 3, Malformed mail' } },
  { name: 'transport-padding', generator: 'transportPadding', source: [], attacks: 'whitespace after delimiters (legal, RFC 2046 transport padding)', expected: { outcome: "two text/plain parts, 'first' and 'second'; no problem", noProblems: true, texts: ['first', 'second'], timeBoundMs: T, proposal: 'section 3, Boundaries' } },
  { name: 'line-end-mix', generator: 'lineEndMix', source: [], attacks: 'CRLF, LF and bare CR mixed (SMTP smuggling class)', expected: { outcome: "three text/plain parts: 'crlf one\\r\\ncrlf two', 'lf one\\nlf two', 'bare\\rcr\\r\\n--mix\\rX not a delimiter' (the bare CR is a character, so that line is no delimiter)", texts: ['crlf one\r\ncrlf two', 'lf one\nlf two', 'bare\rcr\r\n--mix\rX not a delimiter'], timeBoundMs: T, proposal: 'section 3, Line ends' } },
  { name: 'base64-junk', generator: 'base64Junk', source: [], attacks: 'base64 with junk, mid-stream padding and a partial quantum', expected: { outcome: "text 'ABCDEFG'; base64-junk (informational)", texts: ['ABCDEFG'], problems: ['base64-junk'], timeBoundMs: T, proposal: 'section 3, Transfer encodings' } },
  { name: 'pgp-mime-encrypted', generator: 'pgpMimeEncrypted', source: ['RFC 3156'], attacks: 'shape only (placeholder armor)', expected: { outcome: "one decrypt step for the root, pending; the message shows one encrypted part with reason 'pending'; no problem", steps: ['decrypt'], noProblems: true, timeBoundMs: T, proposal: 'section 5, PGP/MIME encrypted' } },
  { name: 'exchange-pgp-mime', generator: 'exchangePgpMime', source: ['section 5, Exchange\'s rewrite'], attacks: 'shape only (placeholder armor)', expected: { outcome: 'read as multipart/encrypted: one decrypt step for the root; exchange-shape (informational)', steps: ['decrypt'], problems: ['exchange-shape'], timeBoundMs: T, proposal: 'section 5, Exchange\'s rewrite' } },
  { name: 'pgp-mime-signed', generator: 'pgpMimeSigned', source: ['RFC 3156'], attacks: 'shape only (placeholder armor)', expected: { outcome: 'one verify step for the root, signed Ref not canonical; no problem', steps: ['verify'], noProblems: true, timeBoundMs: T, proposal: 'section 5, PGP/MIME signed' } },
  { name: 'pgp-mime-signed-lf', generator: 'pgpMimeSignedLf', source: ['RFC 3156'], attacks: 'shape only, bare LF line ends', expected: { outcome: 'one verify step; the signed Ref is canonical; canonicalized (informational)', steps: ['verify'], problems: ['canonicalized'], timeBoundMs: T, proposal: 'section 5, PGP/MIME signed' } },
];

writeFileSync(
  join(dir, 'manifest.json'),
  JSON.stringify(
    {
      format: {
        file: 'a fixture in this directory', generator: 'an export of test/mime-corpus.ts (generators[name]())',
        source: 'where the input comes from: advisory, fix commit or test', attacks: 'what it attacks',
        'expected.outcome': "the expected outcome in the proposal's terms (docs/proposals/sinter-mail-mime.md), prose",
        'expected.problems': 'problem codes that must be present', 'expected.noProblems': 'no problem at all',
        'expected.blocking': 'the problems block every step in or below their entity', 'expected.noSteps': 'steps is empty',
        'expected.steps': 'the kinds of the steps, in order', 'expected.tree': 'content types, as in stalwart/structure.json',
        'expected.addresses': 'over the named Headers fields: oneOf / exactly / includes / never (address values, null for address: null), domainOneOf',
        'expected.suspicious': 'fields whose address must carry suspicious: true', 'expected.noControls': 'no decoded value holds NUL, C0, CR, LF or bidi controls',
        'expected.summaryFrom': "summary.from", 'expected.timeBoundMs': 'the call finishes within this bound (section 4)',
        note: "field-dropped is named in section 4 but missing from section 2's closed problem table",
      },
      fixtures,
      generators: generated,
    },
    null,
    2,
  ) + '\n',
);
