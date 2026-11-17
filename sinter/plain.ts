// mail.plain: a placeholder until plain text lands.
import type { Body, PlainOptions } from './sinter.types.js';

export function plain(_text: string | null | undefined, _options?: PlainOptions): Body {
  return { type: 'body', style: {}, children: [], images: { origins: [] } };
}
