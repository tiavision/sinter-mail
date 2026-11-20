// The tree that mail.parse (HTML) and mail.plain (plain text) return, and that <mail-body> renders. An app
// names these in its own declarations (`export type { Body } from '@tiavision/sinter-mail'` in its
// src/sinter.types.ts); an API that runs the parse on the server sends this tree as JSON.
//
// Every element is one the browser's own parser would build from the same HTML, restricted to the tags
// of sinter/tags.ts, with only that tag's attributes and the properties the cascade resolved for it.

/** The allowed tags (sinter/tags.ts is the table; test/components.test.ts checks that the two agree). */
export type Tag =
  | 'a' | 'abbr' | 'address' | 'article' | 'aside' | 'b' | 'bdi' | 'bdo' | 'blockquote' | 'br' | 'caption'
  | 'center' | 'cite' | 'code' | 'col' | 'colgroup' | 'dd' | 'del' | 'details' | 'dfn' | 'div' | 'dl' | 'dt'
  | 'em' | 'figcaption' | 'figure' | 'font' | 'footer' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'header'
  | 'hr' | 'i' | 'img' | 'ins' | 'kbd' | 'li' | 'main' | 'mark' | 'nav' | 'ol' | 'p' | 'pre' | 'q' | 's'
  | 'samp' | 'section' | 'small' | 'span' | 'strike' | 'strong' | 'sub' | 'summary' | 'sup' | 'table'
  | 'tbody' | 'td' | 'tfoot' | 'th' | 'thead' | 'time' | 'tr' | 'tt' | 'u' | 'ul' | 'var' | 'wbr';

/** The attributes an element may keep (which ones a tag keeps: sinter/tags.ts). Values are strings. */
export interface Attrs {
  href?: string;
  title?: string;
  src?: string;
  alt?: string;
  width?: string;
  height?: string;
  id?: string;
  dir?: string;
  lang?: string;
  colspan?: string;
  rowspan?: string;
  headers?: string;
  scope?: string;
  abbr?: string;
  span?: string;
  start?: string;
  reversed?: string;
  type?: string;
  value?: string;
  open?: string;
  cite?: string;
  datetime?: string;
}

/**
 * The declarations the cascade resolved for an element: its legacy attributes, the email's `<style>`
 * rules and its `style` attribute, in that order of precedence, then only the allowed properties
 * (sinter/tags.ts, PROPERTIES), each value re-serialized. Rendered inline with `data-sn-style`.
 */
export type Style = { [P in Property]?: string };

export type Property =
  | 'color' | 'background-color'
  | 'font-family' | 'font-size' | 'font-style' | 'font-weight' | 'font-variant'
  | 'line-height' | 'letter-spacing' | 'word-spacing'
  | 'text-align' | 'text-decoration' | 'text-transform' | 'text-indent' | 'white-space'
  | 'vertical-align' | 'word-break' | 'overflow-wrap'
  | 'width' | 'height' | 'min-width' | 'max-width' | 'min-height' | 'max-height'
  | 'margin-top' | 'margin-right' | 'margin-bottom' | 'margin-left'
  | 'padding-top' | 'padding-right' | 'padding-bottom' | 'padding-left'
  | 'border-top-width' | 'border-right-width' | 'border-bottom-width' | 'border-left-width'
  | 'border-top-style' | 'border-right-style' | 'border-bottom-style' | 'border-left-style'
  | 'border-top-color' | 'border-right-color' | 'border-bottom-color' | 'border-left-color'
  | 'border-top-left-radius' | 'border-top-right-radius' | 'border-bottom-right-radius' | 'border-bottom-left-radius'
  | 'border-collapse' | 'border-spacing' | 'table-layout' | 'caption-side'
  | 'display' | 'list-style-type' | 'list-style-position' | 'overflow' | 'opacity' | 'box-sizing' | 'float' | 'clear';

export interface Text {
  type: 'text';
  value: string;
  /** the node's index in document order, set by mail.progressive: its row's key, and where a step of a progressive render ends */
  n?: number;
}

export interface Element {
  type: 'element';
  tag: Tag;
  attrs: Attrs;
  style: Style;
  /** what the element is in the message: a quoted reply, the signature (mail.plain sets them) */
  part?: 'quote' | 'signature';
  children: Node[];
  /** the node's index in document order, and the last index in its subtree (mail.progressive) */
  n?: number;
  z?: number;
}

export type Node = Element | Text;

export interface Body {
  type: 'body';
  /** the resolved style of the email's `<body>` (its background, its font), rendered on the root */
  style: Style;
  children: Node[];
  images: ImageInfo;
  /**
   * The colour schemes the email is written for, `light` before `dark`; absent when it says nothing (it was
   * written for a white page). Those its `color-scheme` and `supported-color-schemes` metas name, or the
   * `color-scheme` property of its `<html>` or `<body>`; and `dark` whenever its colours change with
   * `prefers-color-scheme`: then those colours are `light-dark(<light>, <dark>)` in the elements' styles, and
   * follow the colour scheme the body is shown in. With `dark` here, the email may be shown on a dark page as
   * it is; without, an app keeps it light there (`color-scheme: light` around it).
   */
  schemes?: ('light' | 'dark')[];
  /** set by mail.progressive: <mail-body> renders the nodes with an index below this first, the rest after the browser has painted them */
  head?: number;
  /** set by mail.progressive: the body up to `head`, the subtrees it holds whole shared with the body */
  first?: Body;
}

export interface ImageInfo {
  /** every remote image's origin (`https://cdn.example`), sorted, once each, whatever `images` is */
  origins: string[];
}

export interface ParseOptions {
  /**
   * What a remote (`http:`, `https:`) image becomes: `'block'` (the default) leaves it out, keeping its box;
   * `'allow'` keeps it as written; `'proxy'` keeps it through the `proxy` template.
   */
  images?: 'block' | 'allow' | 'proxy';
  /** with `images: 'proxy'`: a URL template with `{url}` once, `'/api/email/proxy-image?url={url}'` */
  proxy?: string;
  /**
   * `cid:` images (inline parts): a map from content id (without `<>`) to a URL, or a template with
   * `{cid}` once. An unresolved one is left out.
   */
  cid?: Record<string, string> | string;
  /** the width `@media` rules are evaluated at: `'wide'` (the default, 800 px) or `'narrow'` (375 px) */
  media?: 'wide' | 'narrow';
  /** the largest `data:` image kept, in characters of its URL (default 65536; 0 keeps none) */
  dataImages?: number;
}

export interface PlainOptions {
  /** the text is `format=flowed` (RFC 3676): soft line breaks are joined back into paragraphs */
  flowed?: boolean;
  /** with `flowed`: `DelSp=yes`, the space before a soft line break is removed too */
  delsp?: boolean;
}

/** a link of the body, as mail.links returns it */
export interface LinkInfo {
  href: string;
  text: string;
}
