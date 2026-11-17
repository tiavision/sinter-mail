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
const IN_HEAD_TAGS = set('base basefont bgsound link meta noframes script style template title');
const EXITS = set('b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var');
const MODE_TAGS = set('tr tbody thead tfoot caption colgroup table frameset select template td th head body html');
// doctypes that put the document in quirks mode, where `<p>` stays open around a `<table>`: these public
// identifiers, and those that start with one of the prefixes (the standard's lists, lowercased)
const QUIRKY_IDS = new Set(['-//w3o//dtd w3 html strict 3.0//en//', '-/w3c/dtd html 4.0 transitional/en', 'html']);
const QUIRKY_PREFIXES = ("+//silmaril//dtd html pro v0r11 19970101//|-//as//dtd html 3.0 aswedit + extensions//|-//advasoft ltd//dtd html 3.0 aswedit + extensions//|-//ietf//dtd html 2.0 level 1//|-//ietf//dtd html 2.0 level 2//|-//ietf//dtd html 2.0 strict level 1//|-//ietf//dtd html 2.0 strict level 2//|-//ietf//dtd html 2.0 strict//|-//ietf//dtd html 2.0//|-//ietf//dtd html 2.1e//|-//ietf//dtd html 3.0//|-//ietf//dtd html 3.2 final//|-//ietf//dtd html 3.2//|-//ietf//dtd html 3//|-//ietf//dtd html level 0//|-//ietf//dtd html level 1//|-//ietf//dtd html level 2//|-//ietf//dtd html level 3//|-//ietf//dtd html strict level 0//|-//ietf//dtd html strict level 1//|-//ietf//dtd html strict level 2//|-//ietf//dtd html strict level 3//|-//ietf//dtd html strict//|-//ietf//dtd html//|-//metrius//dtd metrius presentational//|-//microsoft//dtd internet explorer 2.0 html strict//|-//microsoft//dtd internet explorer 2.0 html//|-//microsoft//dtd internet explorer 2.0 tables//|-//microsoft//dtd internet explorer 3.0 html strict//|-//microsoft//dtd internet explorer 3.0 html//|-//microsoft//dtd internet explorer 3.0 tables//|-//netscape comm. corp.//dtd html//|-//netscape comm. corp.//dtd strict html//|-//o'reilly and associates//dtd html 2.0//|-//o'reilly and associates//dtd html extended 1.0//|-//o'reilly and associates//dtd html extended relaxed 1.0//|-//sq//dtd html 2.0 hotmetal + extensions//|-//softquad software//dtd hotmetal pro 6.0::19990601::extensions to html 4.0//|-//softquad//dtd hotmetal pro 4.0::19971010::extensions to html 4.0//|-//spyglass//dtd html 2.0 extended//|-//sun microsystems corp.//dtd hotjava html//|-//sun microsystems corp.//dtd hotjava strict html//|-//w3c//dtd html 3 1995-03-24//|-//w3c//dtd html 3.2 draft//|-//w3c//dtd html 3.2 final//|-//w3c//dtd html 3.2//|-//w3c//dtd html 3.2s draft//|-//w3c//dtd html 4.0 frameset//|-//w3c//dtd html 4.0 transitional//|-//w3c//dtd html experimental 19960712//|-//w3c//dtd html experimental 970421//|-//w3c//dtd w3 html//|-//w3o//dtd w3 html 3.0//|-//webtechs//dtd mozilla html 2.0//|-//webtechs//dtd mozilla html//").split('|');
