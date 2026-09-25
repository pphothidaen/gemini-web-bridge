import * as modelCatalog from './src/model-catalog.js';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const doSource = fs.readFileSync('./src/index.js', 'utf8');
const stripped = doSource.replace(/import[\\s\\S]*?from "[^"]+";/g, '').replaceAll('export class ', 'class ').replace('export default {', 'const entry = {');

const context = {
  ...modelCatalog,
  DurableObject: class {},
  crypto: { randomUUID, subtle: null, ...globalThis.crypto },
  Request: globalThis.Request,
  Response: globalThis.Response,
  URL: globalThis.URL,
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  TextEncoderStream: globalThis.TextEncoderStream,
  TransformStream: globalThis.TransformStream,
  ReadableStream: globalThis.ReadableStream,
  console: globalThis.console,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: () => {},
};

const hasImports = stripped.split('\n').some(l => l.includes('import '));
console.log('Has imports after strip:', hasImports);
console.log('First 5 lines of stripped source:');
stripped.split('\n').slice(0, 5).forEach((l, i) => console.log(i+1, l));

try {
  const result = vm.runInNewContext(stripped + ';({GeminiBridgeDO})', context);
  console.log('Success! Keys:', Object.keys(result));
} catch (e) {
  console.log('Error:', e.message);
}
