import { expect, test } from 'vitest';
import { plainOf, reference } from './reference.js';

test('the reference parse builds the browser tree', () => {
  const r = reference('<table><tr><td>a<p>b<td>c</table><svg><g/></svg><b>x<!--c-->y</b>');
  expect(plainOf(r)).toEqual(['html', {}, ['head', {}], ['body', {}, ['table', {}, ['tbody', {}, ['tr', {}, ['td', {}, 'a', ['p', {}, 'b']], ['td', {}, 'c']]]], ['b', {}, 'xy']]]);
});
