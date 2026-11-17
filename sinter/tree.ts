// mail.text and mail.links: a placeholder until they land.
import type { Body, LinkInfo, Node } from './sinter.types.js';

export function text(_node: Node | Body | null | undefined): string { return ''; }
export function links(_body: Body | null | undefined): LinkInfo[] { return []; }
