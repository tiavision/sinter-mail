// prints IR templates of a kept build: node bench/tmp/ir.mjs <dist> [ids...]
import { readFileSync, readdirSync } from 'node:fs';
const [dist, ...ids] = process.argv.slice(2);
const f = readdirSync(dist + '/assets').find((x) => x.startsWith('index'));
const js = readFileSync(dist + '/assets/' + f, 'utf8');
const start = js.indexOf('var ir = ');
const end = js.indexOf('\n};\n', start);
const ir = new Function('return ' + js.slice(start + 'var ir = '.length, end + 2))();
const ts = ir.templates;
console.log('ir keys', Object.keys(ir), 'templates', ts.length);
for (const id of ids) console.log(id, JSON.stringify(ts.find((t) => t.id == id) ?? ts[id]));
