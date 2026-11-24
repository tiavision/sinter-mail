// The package's entry: the helpers, which an app re-exports as a namespace
// (`export * as mail from '@tiavision/sinter-mail'`), and the tree's types
// (`export type { Body } from '@tiavision/sinter-mail'` in its src/sinter.types.ts), and the MIME reader's types
// (`Message`, `Part`, `Ref`, …).
export * from './sinter.helpers.js';
export type * from './sinter.types.js';
export type * from './mime/types.js';
