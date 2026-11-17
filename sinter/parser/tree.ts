// The HTML standard's tree construction, as parse5 runs it (test/reference.ts is the oracle): the insertion
// modes a document goes through, the stack of open elements and its scopes, the list of active formatting
// elements (with the Noah's Ark clause and reconstruction), the adoption agency, foster parenting, implied
// end tags and the head and form element pointers. Scripting is on, as in parse5's default: `<noscript>` is
// raw text. Where parse5 departs from the standard's text, this follows parse5, as browsers' trees are
// what it has to match: table scope stops only at `html` and `table`, implied end tags "except for" one use
// the thorough list, `</tbody>` in a row closes it when a `tr` is in scope, and `<![CDATA[` is a section only
// where the current node is foreign and not an integration point.
//
// Foreign content (`<svg>`, `<math>`) is parsed as the standard says, so that what follows it lands where
// it should; the raw tree leaves it out with its subtree (index.ts). A `<template>`'s content goes to a
// fragment of its own, which the raw tree leaves out too.
//
// Bounded: the stack holds at most `maxDepth` elements. An element that would open deeper closes the
// current node first and opens beside it (as Blink flattens deep trees), so every search of the stack is
// bounded and the parse stays linear; below the bound nothing changes.
import { tokenize, DATA, PLAINTEXT, RAWTEXT, RCDATA, SCRIPT, type Attrs, type Sink } from './tokenizer.js';

export const HTML = 0, SVG = 1, MATH = 2;

export interface Node {
  tag: string;
  ns: number;
  attrs: Attrs;
  /** elements and texts (strings, adjacent ones joined) */
  kids: (Node | string)[];
  parent: Node | null;
  /** on the stack of open elements */
  open: boolean;
  /** in the list of active formatting elements */
  listed: boolean;
  /** a template's content */
  content: Node | null;
}

interface Tag {
  name: string;
  attrs: Attrs;
  selfClosing: boolean;
}

const INITIAL = 0, BEFORE_HTML = 1, BEFORE_HEAD = 2, IN_HEAD = 3, AFTER_HEAD = 4, IN_BODY = 5, TEXT = 6,
  IN_TABLE = 7, IN_TABLE_TEXT = 8, IN_CAPTION = 9, IN_COLUMN_GROUP = 10, IN_TABLE_BODY = 11, IN_ROW = 12,
  IN_CELL = 13, IN_SELECT = 14, IN_SELECT_IN_TABLE = 15, IN_TEMPLATE = 16, AFTER_BODY = 17, IN_FRAMESET = 18,
  AFTER_FRAMESET = 19, AFTER_AFTER_BODY = 20, AFTER_AFTER_FRAMESET = 21;
// scopes
const DEFAULT = 0, LIST_ITEM = 1, BUTTON = 2, TABLE = 3;

const set = (s: string): Set<string> => new Set(s.split(' '));
const FORMATTING = set('b big code em font i s small strike strong tt u');
const HEADINGS = set('h1 h2 h3 h4 h5 h6');
const BLOCKS = 'address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer header hgroup main menu nav ol search section summary ul';
const BLOCK_START = set(BLOCKS + ' p');
const BLOCK_END = set(BLOCKS + ' button listing pre');
const SPECIAL = set('address applet area article aside base basefont bgsound blockquote body br button caption center col colgroup dd details dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input keygen li link listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre script section select source style summary table tbody td template textarea tfoot th thead title tr track ul wbr xmp');
const SCOPE = set('applet caption html marquee object table td template th');
const MARKERS = set('applet caption marquee object td template th');
const MATH_TEXT = set('mi mo mn ms mtext');
const MATH_SCOPE = set('mi mo mn ms mtext annotation-xml');
const SVG_HTML = set('foreignobject desc title');
const IMPLIED = set('dd dt li optgroup option p rb rp rt rtc');
const THOROUGH = set('dd dt li optgroup option p rb rp rt rtc caption colgroup tbody td tfoot th thead tr');
const TABLE_STRUCTURE = set('table tbody tfoot thead tr');
const TABLE_PARTS = set('caption col colgroup tbody td tfoot th thead tr');
const SELECT_ENDS = set('caption table tbody td tfoot th thead tr');
const TABLE_BODIES = set('tbody tfoot thead');
const CELLS = set('td th');
const TABLE_CONTEXT = set('table template html');
const BODY_CONTEXT = set('tbody tfoot thead template html');
const ROW_CONTEXT = set('tr template html');
const IN_HEAD_TAGS = set('base basefont bgsound link meta noframes script style template title');
const EXITS = set('b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var');
const MODE_TAGS = set('tr tbody thead tfoot caption colgroup table frameset select template td th head body html');
// doctypes that put the document in quirks mode, where `<p>` stays open around a `<table>`: these public
// identifiers, and those that start with one of the prefixes (the standard's lists, lowercased)
const QUIRKY_IDS = new Set(['-//w3o//dtd w3 html strict 3.0//en//', '-/w3c/dtd html 4.0 transitional/en', 'html']);
const QUIRKY_PREFIXES = ("+//silmaril//dtd html pro v0r11 19970101//|-//as//dtd html 3.0 aswedit + extensions//|-//advasoft ltd//dtd html 3.0 aswedit + extensions//|-//ietf//dtd html 2.0 level 1//|-//ietf//dtd html 2.0 level 2//|-//ietf//dtd html 2.0 strict level 1//|-//ietf//dtd html 2.0 strict level 2//|-//ietf//dtd html 2.0 strict//|-//ietf//dtd html 2.0//|-//ietf//dtd html 2.1e//|-//ietf//dtd html 3.0//|-//ietf//dtd html 3.2 final//|-//ietf//dtd html 3.2//|-//ietf//dtd html 3//|-//ietf//dtd html level 0//|-//ietf//dtd html level 1//|-//ietf//dtd html level 2//|-//ietf//dtd html level 3//|-//ietf//dtd html strict level 0//|-//ietf//dtd html strict level 1//|-//ietf//dtd html strict level 2//|-//ietf//dtd html strict level 3//|-//ietf//dtd html strict//|-//ietf//dtd html//|-//metrius//dtd metrius presentational//|-//microsoft//dtd internet explorer 2.0 html strict//|-//microsoft//dtd internet explorer 2.0 html//|-//microsoft//dtd internet explorer 2.0 tables//|-//microsoft//dtd internet explorer 3.0 html strict//|-//microsoft//dtd internet explorer 3.0 html//|-//microsoft//dtd internet explorer 3.0 tables//|-//netscape comm. corp.//dtd html//|-//netscape comm. corp.//dtd strict html//|-//o'reilly and associates//dtd html 2.0//|-//o'reilly and associates//dtd html extended 1.0//|-//o'reilly and associates//dtd html extended relaxed 1.0//|-//sq//dtd html 2.0 hotmetal + extensions//|-//softquad software//dtd hotmetal pro 6.0::19990601::extensions to html 4.0//|-//softquad//dtd hotmetal pro 4.0::19971010::extensions to html 4.0//|-//spyglass//dtd html 2.0 extended//|-//sun microsystems corp.//dtd hotjava html//|-//sun microsystems corp.//dtd hotjava strict html//|-//w3c//dtd html 3 1995-03-24//|-//w3c//dtd html 3.2 draft//|-//w3c//dtd html 3.2 final//|-//w3c//dtd html 3.2//|-//w3c//dtd html 3.2s draft//|-//w3c//dtd html 4.0 frameset//|-//w3c//dtd html 4.0 transitional//|-//w3c//dtd html experimental 19960712//|-//w3c//dtd html experimental 970421//|-//w3c//dtd w3 html//|-//w3o//dtd w3 html 3.0//|-//webtechs//dtd mozilla html 2.0//|-//webtechs//dtd mozilla html//").split('|');

/** whether a doctype puts the document in quirks mode */
function quirky(name: string | null, publicId: string | null, systemId: string | null, force: boolean): boolean {
  if (force || name !== 'html') return true;
  if (systemId && systemId.toLowerCase() === 'http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd') return true;
  if (publicId === null) return false;
  const id = publicId.toLowerCase();
  return QUIRKY_IDS.has(id) || QUIRKY_PREFIXES.some((p) => id.startsWith(p)) ||
    (systemId === null && (id.startsWith('-//w3c//dtd html 4.01 frameset//') || id.startsWith('-//w3c//dtd html 4.01 transitional//')));
}

const create = (tag: string, attrs: Attrs, ns: number): Node => ({
  tag, ns, attrs, kids: [], parent: null, open: false, listed: false,
  content: ns === HTML && tag === 'template' ? create('#content', [], HTML) : null,
});

const isWhitespace = (s: string): boolean => !/[^\t\n\f\r ]/.test(s);
const leading = (s: string): number => /^[\t\n\f\r ]*/.exec(s)![0].length;
const noNul = (s: string): string => (s.includes('\0') ? s.replace(/\0/g, '') : s);

/** whether two elements were made from tags with the same attributes, in any order (Noah's Ark) */
function sameAttrs(a: Attrs, b: Attrs): boolean {
  if (a.length !== b.length) return false;
  if (a.length < 8) return a.every(([n, v]) => b.some((x) => x[0] === n && x[1] === v));
  const m = new Map(a);
  return b.every(([n, v]) => m.get(n) === v);
}

/** `html` parsed into its `<html>` element, with foreign elements and template contents still in it */
export function build(html: string, maxDepth: number): Node {
  maxDepth = Math.max(maxDepth, 3); // html, body and one element; the bound never closes the body
  const stack: Node[] = [];
  /** the list of active formatting elements; null is a marker */
  const list: (Node | null)[] = [];
  const templateModes: number[] = [];
  let mode = INITIAL, original = INITIAL, quirks = false, framesetOk = true, foster = false, skipNewline = false;
  let root: Node | null = null, head: Node | null = null, form: Node | null = null, templates = 0, raw = DATA, pending = '';

  // the stack of open elements

  const cur = (): Node => stack[stack.length - 1];
  const is = (n: Node | undefined, tag: string): boolean => !!n && n.ns === HTML && n.tag === tag;
  const push = (n: Node): void => {
    stack.push(n);
    n.open = true;
    if (is(n, 'template')) templates++;
  };
  const closed = (n: Node): void => {
    n.open = false;
    if (is(n, 'template')) templates--;
  };
  const pop = (): Node => {
    const n = stack.pop()!;
    closed(n);
    return n;
  };
  /** pops down to `length` elements; the root always stays */
  const popTo = (length: number): void => { while (stack.length > Math.max(length, 1)) pop(); };
  const removeAt = (i: number): void => {
    if (i < 1) return;
    closed(stack[i]);
    stack.splice(i, 1);
  };
  /** the index of the topmost open HTML element with this tag (or one of these tags), or -1 */
  const top = (t: string | Set<string>): number => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const n = stack[i];
      if (n.ns === HTML && (typeof t === 'string' ? n.tag === t : t.has(n.tag))) return i;
    }
    return -1;
  };
  const popUntil = (t: string | Set<string>): void => {
    const i = top(t);
    if (i >= 0) popTo(i);
  };
  const special = (n: Node): boolean => (n.ns === HTML ? SPECIAL : n.ns === MATH ? MATH_SCOPE : SVG_HTML).has(n.tag);
  const boundary = (n: Node, scope: number): boolean =>
    n.ns === HTML
      ? scope === TABLE ? n.tag === 'html' || n.tag === 'table'
        : SCOPE.has(n.tag) || (scope === LIST_ITEM && (n.tag === 'ol' || n.tag === 'ul')) || (scope === BUTTON && n.tag === 'button')
      : scope !== TABLE && special(n);
  const inScope = (t: string | Set<string>, scope = DEFAULT, el?: Node): boolean => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const n = stack[i];
      if (n.ns === HTML && (typeof t === 'string' ? n.tag === t : t.has(n.tag)) && (!el || n === el)) return true;
      if (boundary(n, scope)) return false;
    }
    return true;
  };
  const inSelectScope = (tag: string): boolean => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const n = stack[i];
      if (n.ns !== HTML || n.tag === 'option' || n.tag === 'optgroup') continue;
      return n.tag === tag;
    }
    return true;
  };
  /** generates implied end tags, but not for `except` */
  const implied = (except?: string, tags = IMPLIED): void => {
    for (let c = cur(); c.ns === HTML && c.tag !== except && tags.has(c.tag); c = cur()) pop();
  };
  const closeP = (): void => {
    implied('p', THOROUGH);
    popUntil('p');
  };
  const closePInButtonScope = (): void => { if (inScope('p', BUTTON)) closeP(); };

  // integration points: where foreign content holds HTML (or MathML text)
  const htmlPoint = (n: Node): boolean =>
    n.ns === SVG ? SVG_HTML.has(n.tag)
      : n.ns === MATH && n.tag === 'annotation-xml' && n.attrs.some(([a, v]) => a === 'encoding' && /^(?:text\/html|application\/xhtml\+xml)$/i.test(v));
  const point = (n: Node): boolean => htmlPoint(n) || (n.ns === MATH && MATH_TEXT.has(n.tag));
  /** the current node is foreign and no integration point: text and start tags are foreign content */
  const inForeign = (): boolean => {
    const c = cur();
    return !!c && c.ns !== HTML && !point(c);
  };

  // inserting

  /** where a node goes: [parent, the node it goes before] */
  const place = (): [Node, Node | null] => {
    const c = cur();
    return foster && TABLE_STRUCTURE.has(c.tag) ? fosterPlace() : [c.content ?? c, null];
  };
  /** foster parenting: before the last table, or in the template opened after it */
  const fosterPlace = (): [Node, Node | null] => {
    const t = top('table'), tp = top('template');
    if (tp > t) return [stack[tp].content!, null];
    if (t < 0) return [stack[0], null];
    const table = stack[t];
    return table.parent ? [table.parent, table] : [stack[t - 1], null];
  };
  const attach = (n: Node, [parent, before]: [Node, Node | null]): void => {
    n.parent = parent;
    if (before) parent.kids.splice(parent.kids.lastIndexOf(before), 0, n);
    else parent.kids.push(n);
  };
  const detach = (n: Node): void => {
    const p = n.parent;
    if (p) p.kids.splice(p.kids.lastIndexOf(n), 1);
    n.parent = null;
  };
  const insertText = (s: string): void => {
    const [parent, before] = place();
    const k = parent.kids, i = before ? k.lastIndexOf(before) : k.length;
    if (typeof k[i - 1] === 'string') k[i - 1] += s;
    else k.splice(i, 0, s);
  };
  /** inserts an element and opens it; at the bound, the current node closes first */
  const insert = (tag: string, attrs: Attrs = [], ns = HTML): Node => {
    if (stack.length >= maxDepth) {
      const n = pop();
      if (n.listed) unlist(n);
      if (n.ns === HTML && MARKERS.has(n.tag)) clearToMarker();
      if (is(n, 'template')) templateModes.pop();
    }
    const n = create(tag, attrs, ns);
    attach(n, place());
    push(n);
    return n;
  };
  /** inserts an element that does not open (a void element, a self-closing foreign one) */
  const append = (tag: string, attrs: Attrs, ns = HTML): void => attach(create(tag, attrs, ns), place());
  const mergeAttrs = (n: Node, attrs: Attrs): void => {
    const names = new Set(n.attrs.map((a) => a[0]));
    for (const a of attrs) if (!names.has(a[0])) n.attrs.push(a);
  };

  // the list of active formatting elements

  const unlist = (n: Node): void => {
    const i = list.lastIndexOf(n);
    if (i >= 0) list.splice(i, 1);
    n.listed = false;
  };
  const clearToMarker = (): void => {
    for (let e = list.pop(); e; e = list.pop()) e.listed = false;
  };
  const listPush = (n: Node): void => {
    // Noah's Ark: at most three entries with the same tag and attributes after the last marker
    let count = 0, earliest: Node | null = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e) break;
      if (e.tag === n.tag && e.ns === n.ns && sameAttrs(e.attrs, n.attrs)) { count++; earliest = e; }
    }
    if (count >= 3) unlist(earliest!);
    list.push(n);
    n.listed = true;
  };
  /** the last formatting element after the last marker with this tag */
  const listed = (tag: string): Node | null => {
    for (let i = list.length - 1; i >= 0 && list[i]; i--) if (list[i]!.tag === tag) return list[i];
    return null;
  };
  const reconstruct = (): void => {
    let i = list.length;
    if (!i || !list[i - 1] || list[i - 1]!.open) return;
    while (i > 0 && list[i - 1] && !list[i - 1]!.open) i--;
    // not past the bound: what is left is reconstructed once the stack is shallower
    for (; i < list.length && stack.length < maxDepth; i++) {
      const e = list[i]!, n = insert(e.tag, e.attrs, e.ns);
      e.listed = false;
      n.listed = true;
      list[i] = n;
    }
  };

  /** the adoption agency algorithm, for an end tag of a formatting element (or `<a>`, `<nobr>`) */
  const adopt = (tag: string): void => {
    const c = cur();
    if (is(c, tag) && !c.listed) { pop(); return; }
    for (let outer = 0; outer < 8; outer++) {
      const fe = listed(tag);
      if (!fe) return endInBodyOther(tag);
      if (!fe.open) return unlist(fe);
      if (!inScope(tag, DEFAULT, fe)) return;
      const fi = stack.lastIndexOf(fe);
      let bi = fi + 1;
      while (bi < stack.length && !special(stack[bi])) bi++;
      if (bi === stack.length) {
        popTo(fi);
        unlist(fe);
        return;
      }
      const block = stack[bi], common = stack[fi - 1];
      let bookmark: Node = fe, last = block;
      for (let i = 0, k = bi - 1; stack[k] !== fe; i++, k--) {
        const n = stack[k];
        if (!n.listed || i >= 3) {
          if (n.listed) unlist(n);
          removeAt(k);
          continue;
        }
        const clone = create(n.tag, n.attrs, n.ns);
        list[list.lastIndexOf(n)] = clone;
        n.listed = false;
        clone.listed = true;
        closed(n);
        stack[k] = clone;
        clone.open = true;
        if (last === block) bookmark = clone;
        detach(last);
        attach(last, [clone, null]);
        last = clone;
      }
      detach(last);
      if (common) {
        attach(last, TABLE_STRUCTURE.has(common.tag) ? fosterPlace() : [common.content ?? common, null]);
      }
      const n = create(fe.tag, fe.attrs, fe.ns);
      n.kids = block.kids;
      for (const k of n.kids) if (typeof k !== 'string') k.parent = n;
      block.kids = [];
      attach(n, [block, null]);
      list.splice(list.lastIndexOf(bookmark) + 1, 0, n);
      n.listed = true;
      unlist(fe);
      removeAt(stack.lastIndexOf(fe));
      stack.splice(stack.lastIndexOf(block) + 1, 0, n);
      n.open = true;
    }
  };

  // modes

  const resetMode = (): void => {
    const i = top(MODE_TAGS);
    const tag = i < 0 ? '' : stack[i].tag;
    switch (tag) {
      case 'tr': mode = IN_ROW; return;
      case 'tbody': case 'thead': case 'tfoot': mode = IN_TABLE_BODY; return;
      case 'caption': mode = IN_CAPTION; return;
      case 'colgroup': mode = IN_COLUMN_GROUP; return;
      case 'table': mode = IN_TABLE; return;
      case 'body': mode = IN_BODY; return;
      case 'frameset': mode = IN_FRAMESET; return;
      case 'select': {
        const t = top('table');
        mode = i > 0 && t > 0 && t > top('template') ? IN_SELECT_IN_TABLE : IN_SELECT;
        return;
      }
      case 'template': mode = templateModes[templateModes.length - 1]; return;
      case 'html': mode = head ? AFTER_HEAD : BEFORE_HEAD; return;
      case 'td': case 'th': if (i > 0) { mode = IN_CELL; return; } break;
      case 'head': if (i > 0) { mode = IN_HEAD; return; } break;
    }
    mode = IN_BODY;
  };
  const textMode = (t: Tag, state: number): void => {
    insert(t.name, t.attrs);
    raw = state;
    original = mode;
    mode = TEXT;
  };
  const endTemplate = (): void => {
    if (!templates) return;
    implied(undefined, THOROUGH);
    popUntil('template');
    clearToMarker();
    templateModes.pop();
    resetMode();
  };
  const clearToTable = (): void => popTo(top(TABLE_CONTEXT) + 1);
  const clearToBody = (): void => popTo(top(BODY_CONTEXT) + 1);
  const clearToRow = (): void => popTo(top(ROW_CONTEXT) + 1);
  const closeCell = (): void => {
    implied();
    popUntil(CELLS);
    clearToMarker();
    mode = IN_ROW;
  };
  /** a token in a table that does not belong there: processed in body, with foster parenting */
  const fostered = (f: () => void): void => {
    const was = foster;
    foster = true;
    f();
    foster = was;
  };

  // text

  const bodyText = (s: string): void => {
    s = noNul(s);
    if (!s) return;
    reconstruct();
    insertText(s);
    if (!isWhitespace(s)) framesetOk = false;
  };
  const flushTableText = (): void => {
    const s = pending;
    pending = '';
    mode = original;
    if (!isWhitespace(s)) fostered(() => bodyText(s));
    else if (s) insertText(s);
  };
  const text = (s: string): void => {
    for (;;) {
      switch (mode) {
        case INITIAL:
        case BEFORE_HTML:
        case BEFORE_HEAD: {
          s = s.slice(leading(s));
          if (!s) return;
          anythingElse();
          continue;
        }
        case IN_HEAD:
        case AFTER_HEAD:
        case IN_COLUMN_GROUP: {
          const ws = leading(s);
          if (ws) insertText(s.slice(0, ws));
          s = s.slice(ws);
          if (!s) return;
          if (mode === IN_COLUMN_GROUP && !is(cur(), 'colgroup')) return;
          anythingElse();
          continue;
        }
        case TEXT: return insertText(s);
        case IN_TABLE:
        case IN_TABLE_BODY:
        case IN_ROW: {
          if (TABLE_STRUCTURE.has(cur().tag)) {
            pending = '';
            original = mode;
            mode = IN_TABLE_TEXT;
            continue;
          }
          return fostered(() => bodyText(s));
        }
        case IN_TABLE_TEXT: pending += noNul(s); return;
        case IN_SELECT:
        case IN_SELECT_IN_TABLE: {
          s = noNul(s);
          if (s) insertText(s);
          return;
        }
        case AFTER_BODY:
        case AFTER_AFTER_BODY: {
          const ws = leading(s);
          if (ws) bodyText(s.slice(0, ws));
          s = s.slice(ws);
          if (!s) return;
          mode = IN_BODY;
          continue;
        }
        case IN_FRAMESET:
        case AFTER_FRAMESET:
        case AFTER_AFTER_FRAMESET: {
          s = s.replace(/[^\t\n\f\r ]+/g, '');
          if (s) mode === AFTER_AFTER_FRAMESET ? bodyText(s) : insertText(s);
          return;
        }
        default: return bodyText(s); // in body, caption, cell, template
      }
    }
  };
  /** the "anything else" of the modes before the body, whose effect does not depend on the token */
  const anythingElse = (): void => {
    switch (mode) {
      case INITIAL: quirks = true; mode = BEFORE_HTML; return;
      case BEFORE_HTML: push(root = create('html', [], HTML)); mode = BEFORE_HEAD; return;
      case BEFORE_HEAD: head = insert('head'); mode = IN_HEAD; return;
      case IN_HEAD: pop(); mode = AFTER_HEAD; return;
      case AFTER_HEAD: insert('body'); mode = IN_BODY; return;
      case IN_COLUMN_GROUP: pop(); mode = IN_TABLE; return;
    }
  };

  // start tags

  const startTag = (t: Tag): void => {
    const c = cur();
    if (!c || c.ns === HTML || (t.name === 'svg' && c.ns === MATH && c.tag === 'annotation-xml')) return start(t);
    if (point(c) && !((t.name === 'mglyph' || t.name === 'malignmark') && !htmlPoint(c))) return start(t);
    if (EXITS.has(t.name) || (t.name === 'font' && t.attrs.some(([a]) => a === 'color' || a === 'face' || a === 'size'))) {
      while (cur().ns !== HTML && !point(cur())) pop();
      return start(t);
    }
    if (t.selfClosing) append(t.name, t.attrs, c.ns);
    else insert(t.name, t.attrs, c.ns);
  };

  const start = (t: Tag): void => {
    const name = t.name;
    switch (mode) {
      case INITIAL:
      case BEFORE_HTML:
        if (mode === BEFORE_HTML && name === 'html') {
          push(root = create('html', t.attrs, HTML));
          mode = BEFORE_HEAD;
          return;
        }
        anythingElse();
        return start(t);
      case BEFORE_HEAD:
        if (name === 'html') return startInBody(t);
        if (name === 'head') {
          head = insert('head', t.attrs);
          mode = IN_HEAD;
          return;
        }
        anythingElse();
        return start(t);
      case IN_HEAD:
        if (startInHead(t)) return;
        anythingElse();
        return start(t);
      case AFTER_HEAD:
        switch (name) {
          case 'html': return startInBody(t);
          case 'body': insert(name, t.attrs); framesetOk = false; mode = IN_BODY; return;
          case 'frameset': insert(name, t.attrs); mode = IN_FRAMESET; return;
          case 'head': return;
        }
        if (IN_HEAD_TAGS.has(name)) {
          push(head!);
          startInHead(t);
          removeAt(stack.lastIndexOf(head!));
          return;
        }
        anythingElse();
        return startInBody(t);
      case IN_BODY:
        return startInBody(t);
      case IN_TABLE:
        return startInTable(t);
      case IN_TABLE_TEXT:
        flushTableText();
        return startTag(t);
      case IN_CAPTION:
        if (!TABLE_PARTS.has(name)) return startInBody(t);
        if (!inScope('caption', TABLE)) return;
        implied();
        popUntil('caption');
        clearToMarker();
        mode = IN_TABLE;
        return startInTable(t);
      case IN_COLUMN_GROUP:
        return startInColumnGroup(t);
      case IN_TABLE_BODY:
        return startInTableBody(t);
      case IN_ROW:
        return startInRow(t);
      case IN_CELL:
        if (!TABLE_PARTS.has(name)) return startInBody(t);
        if (inScope('td', TABLE) || inScope('th', TABLE)) {
          closeCell();
          startInRow(t);
        }
        return;
      case IN_SELECT_IN_TABLE:
        if (SELECT_ENDS.has(name)) {
          popUntil('select');
          resetMode();
          return startTag(t);
        }
        return startInSelect(t);
      case IN_SELECT:
        return startInSelect(t);
      case IN_TEMPLATE: {
        if (IN_HEAD_TAGS.has(name)) return void startInHead(t);
        const m = name === 'caption' || name === 'colgroup' || name === 'tbody' || name === 'tfoot' || name === 'thead' ? IN_TABLE
          : name === 'col' ? IN_COLUMN_GROUP : name === 'tr' ? IN_TABLE_BODY : name === 'td' || name === 'th' ? IN_ROW : IN_BODY;
        templateModes[templateModes.length - 1] = mode = m;
        return start(t);
      }
      case AFTER_BODY:
      case AFTER_AFTER_BODY:
        if (name === 'html') return startInBody(t);
        mode = IN_BODY;
        return startInBody(t);
      case IN_FRAMESET:
        switch (name) {
          case 'html': return startInBody(t);
          case 'frameset': insert(name, t.attrs); return;
          case 'frame': append(name, t.attrs); return;
          case 'noframes': startInHead(t); return;
        }
        return;
      default: // after frameset, after after frameset
        if (name === 'html') return startInBody(t);
        if (name === 'noframes') startInHead(t);
    }
  };

  /** a start tag by the rules of "in head"; false for the "anything else" ones */
  const startInHead = (t: Tag): boolean => {
    switch (t.name) {
      case 'html': startInBody(t); return true;
      case 'base': case 'basefont': case 'bgsound': case 'link': case 'meta': append(t.name, t.attrs); return true;
      case 'title': textMode(t, RCDATA); return true;
      case 'noscript': case 'noframes': case 'style': textMode(t, RAWTEXT); return true;
      case 'script': textMode(t, SCRIPT); return true;
      case 'template':
        insert(t.name, t.attrs);
        list.push(null);
        framesetOk = false;
        mode = IN_TEMPLATE;
        templateModes.push(IN_TEMPLATE);
        return true;
      case 'head': return true;
    }
    return false;
  };

  const startInBody = (t: Tag): void => {
    const { name, attrs } = t;
    if (FORMATTING.has(name)) {
      reconstruct();
      return listPush(insert(name, attrs));
    }
    if (BLOCK_START.has(name)) {
      closePInButtonScope();
      insert(name, attrs);
      return;
    }
    if (HEADINGS.has(name)) {
      closePInButtonScope();
      if (cur().ns === HTML && HEADINGS.has(cur().tag)) pop();
      insert(name, attrs);
      return;
    }
    switch (name) {
      case 'a': {
        const a = listed('a');
        if (a) {
          adopt('a');
          if (a.open) removeAt(stack.lastIndexOf(a));
          if (a.listed) unlist(a);
        }
        reconstruct();
        return listPush(insert(name, attrs));
      }
      case 'li': case 'dd': case 'dt': {
        framesetOk = false;
        const i = name === 'li' ? top('li') : Math.max(top('dd'), top('dt'));
        if (i >= 0 && !stack.slice(i + 1).some((n) => special(n) && !(n.ns === HTML && (n.tag === 'address' || n.tag === 'div' || n.tag === 'p')))) {
          implied(stack[i].tag, THOROUGH);
          popUntil(stack[i].tag);
        }
        closePInButtonScope();
        insert(name, attrs);
        return;
      }
      case 'br': case 'img': case 'wbr': case 'area': case 'embed': case 'keygen': case 'image':
        reconstruct();
        append(name === 'image' ? 'img' : name, attrs);
        framesetOk = false;
        return;
      case 'hr':
        closePInButtonScope();
        append(name, attrs);
        framesetOk = false;
        return;
      case 'rb': case 'rtc':
        if (inScope('ruby')) implied();
        insert(name, attrs);
        return;
      case 'rt': case 'rp':
        if (inScope('ruby')) implied('rtc', THOROUGH);
        insert(name, attrs);
        return;
      case 'pre': case 'listing':
        closePInButtonScope();
        insert(name, attrs);
        skipNewline = true;
        framesetOk = false;
        return;
      case 'xmp':
        closePInButtonScope();
        reconstruct();
        framesetOk = false;
        return textMode(t, RAWTEXT);
      case 'svg': case 'math': {
        reconstruct();
        const ns = name === 'svg' ? SVG : MATH;
        if (t.selfClosing) append(name, attrs, ns);
        else insert(name, attrs, ns);
        return;
      }
      case 'html':
        if (!templates) mergeAttrs(stack[0], attrs);
        return;
      case 'body':
        if (is(stack[1], 'body') && !templates) {
          framesetOk = false;
          mergeAttrs(stack[1], attrs);
        }
        return;
      case 'form': {
        if (form && !templates) return;
        closePInButtonScope();
        const f = insert(name, attrs);
        if (!templates) form = f;
        return;
      }
      case 'nobr':
        reconstruct();
        if (inScope('nobr')) {
          adopt('nobr');
          reconstruct();
        }
        return listPush(insert(name, attrs));
      case 'table':
        if (!quirks) closePInButtonScope();
        insert(name, attrs);
        framesetOk = false;
        mode = IN_TABLE;
        return;
      case 'input':
        reconstruct();
        append(name, attrs);
        if (!hidden(attrs)) framesetOk = false;
        return;
      case 'param': case 'track': case 'source':
        append(name, attrs);
        return;
      case 'button':
        if (inScope('button')) {
          implied();
          popUntil('button');
        }
        reconstruct();
        insert(name, attrs);
        framesetOk = false;
        return;
      case 'applet': case 'object': case 'marquee':
        reconstruct();
        insert(name, attrs);
        list.push(null);
        framesetOk = false;
        return;
      case 'iframe':
        framesetOk = false;
        return textMode(t, RAWTEXT);
      case 'noembed': case 'noframes': case 'noscript':
        return textMode(t, RAWTEXT);
      case 'select':
        reconstruct();
        insert(name, attrs);
        framesetOk = false;
        mode = mode === IN_TABLE || mode === IN_CAPTION || mode === IN_TABLE_BODY || mode === IN_ROW || mode === IN_CELL ? IN_SELECT_IN_TABLE : IN_SELECT;
        return;
      case 'option': case 'optgroup':
        if (is(cur(), 'option')) pop();
        reconstruct();
        insert(name, attrs);
        return;
      case 'frameset':
        if (framesetOk && is(stack[1], 'body')) {
          detach(stack[1]);
          popTo(1);
          insert(name, attrs);
          mode = IN_FRAMESET;
        }
        return;
      case 'textarea':
        insert(name, attrs);
        skipNewline = true;
        raw = RCDATA;
        original = mode;
        framesetOk = false;
        mode = TEXT;
        return;
      case 'plaintext':
        closePInButtonScope();
        insert(name, attrs);
        raw = PLAINTEXT;
        return;
      case 'base': case 'basefont': case 'bgsound': case 'link': case 'meta': case 'script': case 'style': case 'template': case 'title':
        startInHead(t);
        return;
      case 'caption': case 'col': case 'colgroup': case 'frame': case 'head': case 'tbody': case 'td': case 'tfoot': case 'th': case 'thead': case 'tr':
        return;
    }
    reconstruct();
    insert(name, attrs);
  };

  const startInTable = (t: Tag): void => {
    const { name, attrs } = t;
    switch (name) {
      case 'td': case 'th': case 'tr':
        clearToTable();
        insert('tbody');
        mode = IN_TABLE_BODY;
        return startInTableBody(t);
      case 'style': case 'script': case 'template':
        startInHead(t);
        return;
      case 'col':
        clearToTable();
        insert('colgroup');
        mode = IN_COLUMN_GROUP;
        return startInColumnGroup(t);
      case 'form':
        if (!form && !templates) {
          form = insert(name, attrs);
          pop();
        }
        return;
      case 'table':
        if (inScope('table', TABLE)) {
          popUntil('table');
          resetMode();
          startTag(t);
        }
        return;
      case 'tbody': case 'tfoot': case 'thead':
        clearToTable();
        insert(name, attrs);
        mode = IN_TABLE_BODY;
        return;
      case 'input':
        if (hidden(attrs)) return append(name, attrs);
        break;
      case 'caption':
        clearToTable();
        list.push(null);
        insert(name, attrs);
        mode = IN_CAPTION;
        return;
      case 'colgroup':
        clearToTable();
        insert(name, attrs);
        mode = IN_COLUMN_GROUP;
        return;
    }
    fostered(() => startInBody(t));
  };

  const startInColumnGroup = (t: Tag): void => {
    switch (t.name) {
      case 'html': return startInBody(t);
      case 'col': return append(t.name, t.attrs);
      case 'template': startInHead(t); return;
    }
    if (!is(cur(), 'colgroup')) return;
    anythingElse();
    startTag(t);
  };

  const startInTableBody = (t: Tag): void => {
    const name = t.name;
    if (name === 'tr') {
      clearToBody();
      insert(name, t.attrs);
      mode = IN_ROW;
    } else if (name === 'th' || name === 'td') {
      clearToBody();
      insert('tr');
      mode = IN_ROW;
      startInRow(t);
    } else if (TABLE_PARTS.has(name) && name !== 'td' && name !== 'th') {
      if (!inScope(TABLE_BODIES, TABLE)) return;
      clearToBody();
      pop();
      mode = IN_TABLE;
      startInTable(t);
    } else startInTable(t);
  };

  const startInRow = (t: Tag): void => {
    const name = t.name;
    if (name === 'th' || name === 'td') {
      clearToRow();
      insert(name, t.attrs);
      mode = IN_CELL;
      list.push(null);
    } else if (TABLE_PARTS.has(name)) {
      if (!inScope('tr', TABLE)) return;
      clearToRow();
      pop();
      mode = IN_TABLE_BODY;
      startInTableBody(t);
    } else startInTable(t);
  };

  const startInSelect = (t: Tag): void => {
    const name = t.name;
    switch (name) {
      case 'html': return startInBody(t);
      case 'option':
        if (is(cur(), 'option')) pop();
        insert(name, t.attrs);
        return;
      case 'optgroup': case 'hr':
        if (is(cur(), 'option')) pop();
        if (is(cur(), 'optgroup')) pop();
        if (name === 'hr') append(name, t.attrs);
        else insert(name, t.attrs);
        return;
      case 'input': case 'keygen': case 'textarea': case 'select':
        if (inSelectScope('select')) {
          popUntil('select');
          resetMode();
          if (name !== 'select') startTag(t);
        }
        return;
      case 'script': case 'template':
        startInHead(t);
    }
  };

  // end tags

  const endTag = (name: string): void => {
    const c = cur();
    if (!c || c.ns === HTML) return end(name);
    if (name === 'p' || name === 'br') {
      while (cur().ns !== HTML && !point(cur())) pop();
      return end(name);
    }
    // the topmost foreign element with this name closes, unless an HTML element is open above it
    for (let i = stack.length - 1; i > 0; i--) {
      const n = stack[i];
      if (n.ns === HTML) break;
      if (n.tag === name) return popTo(i);
    }
    end(name);
  };

  const end = (name: string): void => {
    switch (mode) {
      case INITIAL:
        anythingElse();
        return end(name);
      case BEFORE_HTML:
      case BEFORE_HEAD:
        if (name !== 'html' && name !== 'head' && name !== 'body' && name !== 'br') return;
        anythingElse();
        return end(name);
      case IN_HEAD:
        if (name === 'head') {
          pop();
          mode = AFTER_HEAD;
        } else if (name === 'template') endTemplate();
        else if (name === 'body' || name === 'html' || name === 'br') {
          anythingElse();
          end(name);
        }
        return;
      case AFTER_HEAD:
        if (name === 'template') endTemplate();
        else if (name === 'body' || name === 'html' || name === 'br') {
          anythingElse();
          endInBody(name);
        }
        return;
      case IN_BODY:
        return endInBody(name);
      case TEXT:
        pop();
        mode = original;
        return;
      case IN_TABLE:
        return endInTable(name);
      case IN_TABLE_TEXT:
        flushTableText();
        return endTag(name);
      case IN_CAPTION:
        if (name === 'caption' || name === 'table') {
          if (!inScope('caption', TABLE)) return;
          implied();
          popUntil('caption');
          clearToMarker();
          mode = IN_TABLE;
          if (name === 'table') endInTable(name);
        } else if (!TABLE_PARTS.has(name) && name !== 'body' && name !== 'html') endInBody(name);
        return;
      case IN_COLUMN_GROUP:
        if (name === 'colgroup') {
          if (is(cur(), 'colgroup')) {
            pop();
            mode = IN_TABLE;
          }
        } else if (name === 'template') endTemplate();
        else if (name !== 'col' && is(cur(), 'colgroup')) {
          anythingElse();
          endTag(name);
        }
        return;
      case IN_TABLE_BODY:
        return endInTableBody(name);
      case IN_ROW:
        return endInRow(name);
      case IN_CELL:
        if (name === 'td' || name === 'th') {
          if (!inScope(name, TABLE)) return;
          implied();
          popUntil(name);
          clearToMarker();
          mode = IN_ROW;
        } else if (TABLE_STRUCTURE.has(name)) {
          if (!inScope(name, TABLE)) return;
          closeCell();
          endInRow(name);
        } else if (name !== 'body' && name !== 'caption' && name !== 'col' && name !== 'colgroup' && name !== 'html') endInBody(name);
        return;
      case IN_SELECT_IN_TABLE:
        if (SELECT_ENDS.has(name)) {
          if (inScope(name, TABLE)) {
            popUntil('select');
            resetMode();
            endTag(name);
          }
          return;
        }
        return endInSelect(name);
      case IN_SELECT:
        return endInSelect(name);
      case IN_TEMPLATE:
        if (name === 'template') endTemplate();
        return;
      case AFTER_BODY:
        if (name === 'html') mode = AFTER_AFTER_BODY;
        else {
          mode = IN_BODY;
          endInBody(name);
        }
        return;
      case IN_FRAMESET:
        if (name === 'frameset' && stack.length > 1) {
          pop();
          if (!is(cur(), 'frameset')) mode = AFTER_FRAMESET;
        }
        return;
      case AFTER_FRAMESET:
        if (name === 'html') mode = AFTER_AFTER_FRAMESET;
        return;
      case AFTER_AFTER_BODY:
        mode = IN_BODY;
        return endInBody(name);
    }
  };

  const endInBody = (name: string): void => {
    if (FORMATTING.has(name) || name === 'a' || name === 'nobr') return adopt(name);
    if (BLOCK_END.has(name)) {
      if (inScope(name)) {
        implied();
        popUntil(name);
      }
      return;
    }
    if (HEADINGS.has(name)) {
      if (inScope(HEADINGS)) {
        implied();
        popUntil(HEADINGS);
      }
      return;
    }
    switch (name) {
      case 'p':
        if (!inScope('p', BUTTON)) insert('p');
        return closeP();
      case 'li':
        if (inScope('li', LIST_ITEM)) {
          implied('li', THOROUGH);
          popUntil('li');
        }
        return;
      case 'dd': case 'dt':
        if (inScope(name)) {
          implied(name, THOROUGH);
          popUntil(name);
        }
        return;
      case 'br':
        reconstruct();
        insert('br');
        pop();
        framesetOk = false;
        return;
      case 'body':
        if (inScope('body')) mode = AFTER_BODY;
        return;
      case 'html':
        if (inScope('body')) mode = AFTER_AFTER_BODY;
        return;
      case 'form': {
        const f = form;
        if (!templates) form = null;
        if ((f || templates) && inScope('form')) {
          implied();
          if (templates) popUntil('form');
          else removeAt(stack.lastIndexOf(f!));
        }
        return;
      }
      case 'applet': case 'object': case 'marquee':
        if (inScope(name)) {
          implied();
          popUntil(name);
          clearToMarker();
        }
        return;
      case 'template':
        return endTemplate();
    }
    endInBodyOther(name);
  };

  /** "any other end tag": the topmost element with this name closes, unless a special element is above it */
  const endInBodyOther = (name: string): void => {
    const i = top(name);
    if (i <= 0) return;
    for (let k = i + 1; k < stack.length; k++) if (special(stack[k])) return;
    implied(name, THOROUGH);
    popTo(i);
  };

  const endInTable = (name: string): void => {
    if (name === 'table') {
      if (inScope('table', TABLE)) {
        popUntil('table');
        resetMode();
      }
    } else if (name === 'template') endTemplate();
    else if (!TABLE_PARTS.has(name) && name !== 'body' && name !== 'html') fostered(() => endInBody(name));
  };

  const endInTableBody = (name: string): void => {
    if (name === 'tbody' || name === 'tfoot' || name === 'thead') {
      if (!inScope(name, TABLE)) return;
      clearToBody();
      pop();
      mode = IN_TABLE;
    } else if (name === 'table') {
      if (!inScope(TABLE_BODIES, TABLE)) return;
      clearToBody();
      pop();
      mode = IN_TABLE;
      endInTable(name);
    } else if (!TABLE_PARTS.has(name) && name !== 'body' && name !== 'html') endInTable(name);
  };

  const endInRow = (name: string): void => {
    if (name === 'tr' || name === 'table' || name === 'tbody' || name === 'tfoot' || name === 'thead') {
      if (!inScope('tr', TABLE) && !(name !== 'tr' && name !== 'table' && inScope(name, TABLE))) return;
      clearToRow();
      pop();
      mode = IN_TABLE_BODY;
      if (name !== 'tr') endInTableBody(name);
    } else if (!TABLE_PARTS.has(name) && name !== 'body' && name !== 'html') endInTable(name);
  };

  const endInSelect = (name: string): void => {
    switch (name) {
      case 'optgroup':
        if (is(cur(), 'option') && is(stack[stack.length - 2], 'optgroup')) pop();
        if (is(cur(), 'optgroup')) pop();
        return;
      case 'option':
        if (is(cur(), 'option')) pop();
        return;
      case 'select':
        if (inSelectScope('select')) {
          popUntil('select');
          resetMode();
        }
        return;
      case 'template':
        endTemplate();
    }
  };

  // the end of the input

  const eof = (): void => {
    for (;;) {
      switch (mode) {
        case INITIAL: case BEFORE_HTML: case BEFORE_HEAD: case IN_HEAD: case AFTER_HEAD:
          anythingElse();
          continue;
        case TEXT:
          pop();
          mode = original;
          continue;
        case IN_TABLE_TEXT:
          flushTableText();
          continue;
        case IN_TEMPLATE:
        case IN_BODY: case IN_TABLE: case IN_CAPTION: case IN_COLUMN_GROUP: case IN_TABLE_BODY: case IN_ROW: case IN_CELL: case IN_SELECT: case IN_SELECT_IN_TABLE:
          if (mode !== IN_TEMPLATE && !templateModes.length) return;
          if (!templates) return;
          while (templates) {
            popUntil('template');
            clearToMarker();
            templateModes.pop();
          }
          resetMode();
          continue;
        default:
          return;
      }
    }
  };

  const sink: Sink = {
    text(s) {
      if (skipNewline) {
        skipNewline = false;
        if (s[0] === '\n') s = s.slice(1);
        if (!s) return;
      }
      if (!inForeign()) return text(s);
      // foreign content: NUL is U+FFFD, and only characters other than whitespace and NUL end frameset-ok
      if (!isWhitespace(noNul(s))) framesetOk = false;
      insertText(s.replace(/\0/g, '\uFFFD'));
    },
    start(name, attrs, selfClosing) {
      skipNewline = false;
      raw = DATA;
      startTag({ name, attrs, selfClosing });
      return raw;
    },
    end(name) {
      skipNewline = false;
      endTag(name);
    },
    comment() {
      skipNewline = false;
      if (mode === IN_TABLE_TEXT && (!cur() || cur().ns === HTML)) flushTableText();
    },
    doctype(name, publicId, systemId, force) {
      skipNewline = false;
      if (mode === INITIAL) {
        quirks = quirky(name, publicId, systemId, force);
        mode = BEFORE_HTML;
      } else if (mode === IN_TABLE_TEXT) flushTableText();
    },
    cdata: inForeign,
    eof,
  };
  tokenize(html, sink);
  return root!;
}

const hidden = (attrs: Attrs): boolean => attrs.some(([n, v]) => n === 'type' && v.toLowerCase() === 'hidden');
