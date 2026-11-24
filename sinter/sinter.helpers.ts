// The library's helpers, in five modules under one namespace. An app re-exports the package as a
// namespace (`export * as mail from '@tiavision/sinter-mail'` in its src/sinter.helpers.ts) and calls
// `mail.parse`, `mail.plain`, `mail.text`, `mail.links`, `mail.progressive`, `mail.unquoted`, `mail.mime`,
// `mail.bytes` and `mail.imageType` in markup.
//
// - parse.ts imports the parser (`@tiavision/sinter-mail/parser`). An app that lists this package in
//   `sinter({ lazy })` makes it load when a let first needs it; the let waits for it.
// - plain.ts and tree.ts import no parser, so `mail.plain` and tree.ts's helpers stay ordinary
//   helpers either way: they render early and fold at build time.
// - mime.ts imports the MIME reader (`@tiavision/sinter-mail/mime`): `mail.mime` is lazy as `mail.parse` is.
//   `mail.forget()` drops what mail.mime keeps (on lock or logout), as `mail.mime.clear()` does, reachable from an
//   action when the package is lazy. `mail.cut` is the reference cutter for cut messages, for a server in
//   JavaScript and for tests. bytes.ts imports no reader, so `mail.bytes` and `mail.imageType` stay ordinary helpers.
export { parse } from './parse.js';
export { plain } from './plain.js';
export { text, links, progressive, unquoted } from './tree.js';
export { mime, forget, cut } from './mime.js';
export { bytes, imageType } from './bytes.js';
