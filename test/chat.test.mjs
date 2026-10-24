import assert from 'node:assert/strict';
import { makeHandler } from '../api/chat.js';

const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', GEMINI_API_KEY: 'k' };
const inserted = [];
const fetchFn = async (url, opt) => {
  if (url.endsWith('/rpc/is_member')) return { ok: true, json: async () => opt.headers.Authorization === 'Bearer good' };
  if (url.endsWith('/rest/v1/entries')) { inserted.push(JSON.parse(opt.body)); return { ok: true, status: 201, json: async () => [{ id: 'abc' }] }; }
  throw new Error('url ' + url);
};
function mk(ai) { return makeHandler({ ai, fetchFn, env }); }
function call(h, { method = 'POST', token = 'good', body }) {
  return new Promise(async (resolve) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { resolve({ code: this.statusCode, body: JSON.parse(s) }); } };
    await h({ method, headers: token ? { authorization: 'Bearer ' + token } : {}, body }, res);
  });
}
const turns = [{ role: 'user', content: 'HOY: 2026-10-22' }, { role: 'user', content: 'Brownie hizo popó blanda a las 8' }];

// 1) guarda y responde
let calls = 0, seen;
const ai = { models: { generateContent: async (a) => {
  calls++; seen = a;
  if (calls === 1) return { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'save_entry', args: { type: 'poop', date: '2026-10-22', time: '08:00', title: 'Popó blanda', detail: { consistency: 'blanda', blood: false, evil: { x: 1 } }, raw: 'popó blanda' } }, thoughtSignature: 'sig' }] } }] };
  assert.equal(a.contents.at(-2).parts[0].thoughtSignature, 'sig');
  assert.equal(a.contents.at(-1).parts[0].functionResponse.response.ok, true);
  return { candidates: [{ content: { role: 'model', parts: [{ text: 'Guardé la popó blanda.' }] } }] };
} } };
let r = await call(mk(ai), { body: { turns } });
assert.equal(r.code, 200); assert.equal(r.body.text, 'Guardé la popó blanda.'); assert.equal(r.body.saved[0].id, 'abc');
assert.equal(inserted[0].at, '2026-10-22T08:00'); assert.deepEqual(inserted[0].detail, { consistency: 'blanda', blood: false });
assert.ok(seen.config.systemInstruction.includes('save_entry'));

// 2) errores de acceso
assert.equal((await call(mk(ai), { token: null, body: { turns } })).code, 401);
assert.equal((await call(mk(ai), { token: 'bad', body: { turns } })).code, 403);
assert.equal((await call(mk(ai), { method: 'GET', body: {} })).code, 405);
assert.equal((await call(mk(ai), { body: { turns: [{ role: 'assistant', content: 'hola' }] } })).code, 400);

// 3) datos inválidos no se guardan
inserted.length = 0; calls = 0;
const ai2 = { models: { generateContent: async () => (++calls === 1
  ? { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'save_entry', args: { type: 'zzz', date: 'ayer', title: 'x' } } }] } }] }
  : { candidates: [{ content: { role: 'model', parts: [{ text: 'No pude guardar.' }] } }] }) } };
r = await call(mk(ai2), { body: { turns } });
assert.equal(inserted.length, 0); assert.equal(r.body.saved.length, 0);

// 4) cuota de Gemini
const ai3 = { models: { generateContent: async () => { throw new Error('429 RESOURCE_EXHAUSTED'); } } };
assert.equal((await call(mk(ai3), { body: { turns } })).code, 429);
console.log('chat.test OK');
