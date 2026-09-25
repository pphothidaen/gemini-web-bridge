import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const doSource = fs.readFileSync('./src/index.js', 'utf8');

// Debug: check what we read
console.log('doSource first 6 lines:');
doSource.split('\n').slice(0, 6).forEach((l, i) => console.log(i+1, JSON.stringify(l)));

// Try the regex
const regex = /import[\\s\\S]*?from "[^"]+";/g;
const stripped = doSource.replace(regex, '');

console.log('\nAfter strip, first 6 lines:');
stripped.split('\n').slice(0, 6).forEach((l, i) => console.log(i+1, JSON.stringify(l)));

console.log('\nHas import after strip:', stripped.includes('import { normalizeModels'));

const context = {
  DurableObject: class {},
  crypto: { randomUUID, subtle: null },
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

try {
  const result = vm.runInNewContext(stripped + ';({GeminiBridgeDO})', context);
  console.log('\nSuccess! Keys:', Object.keys(result));
} catch (e) {
  console.log('\nError:', e.message);
}
