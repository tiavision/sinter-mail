// mail.parse: a placeholder until the parser and the cascade land (built in plan steps 3 and 4).
import type { Body, ParseOptions } from './sinter.types.js';

export function parse(_html: string | null | undefined, _options?: ParseOptions): Body {
  return { type: 'body', style: {}, children: [], images: { origins: [] } };
}
