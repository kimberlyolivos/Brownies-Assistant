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

// 5) herramientas nuevas: editar, eliminar (con confirmación), buscar y plan
const db = [{ id: 'abcd1234-0000-0000-0000-000000000001', type: 'symptom', date: '2026-10-25', time: '18:14', title: 'Gases', detail: { what: 'Gases' }, note: '', alert: 'revisar' }];
const plan = { id: 'plan0001-0000-0000-0000-000000000009', type: 'food', date: '2026-06-29', plan: { portions: 4, items: [{ id: 'pavo', group: 'Proteína', name: 'Pavo o pavita', qty: 160, unit: 'g', freq: 'diario', split: true }] } };
const log = [];
const fetch2 = async (url, opt = {}) => {
  const m = opt.method || 'GET';
  if (url.endsWith('/rpc/is_member')) return { ok: true, json: async () => true };
  log.push(m + ' ' + decodeURIComponent(url.split('/rest/v1/')[1]) + (opt.body ? ' ' + opt.body : ''));
  if (m === 'GET' && url.includes('id=like.')) return { ok: true, json: async () => db };
  if (m === 'GET' && url.includes('status=eq.plan')) return { ok: true, json: async () => [plan] };
  if (m === 'GET') return { ok: true, json: async () => db };
  if (m === 'PATCH') return { ok: true, json: async () => [{ ...db[0], ...JSON.parse(opt.body) }] };
  if (m === 'DELETE') return { ok: true, json: async () => [db[0]] };
  if (m === 'POST') return { ok: true, json: async () => [{ id: 'new1' }] };
  throw new Error('url ' + url);
};
function script(...steps) { let i = 0; const seen = []; return { seen, models: { generateContent: async (a) => { seen.push(a); const st = steps[i++]; return { candidates: [{ content: { role: 'model', parts: st.call ? [{ functionCall: { name: st.call, args: st.args } }] : [{ text: st.text }] } }] }; } } }; }
const h2 = (ai) => makeHandler({ ai, fetchFn: fetch2, env });

// editar: quita la alerta
let a2 = script({ call: 'update_entry', args: { id: '#abcd1234', alert: '' } }, { text: 'Listo.' });
r = await call(h2(a2), { body: { turns } });
assert.ok(log.some((l) => l.startsWith('PATCH entries?id=eq.abcd1234') && l.includes('"alert":""')));
assert.equal(r.body.saved[0].title, 'Editado: Gases');

// eliminar sin confirmación no borra; con confirmación sí
log.length = 0;
a2 = script({ call: 'delete_entry', args: { id: 'abcd1234', confirmed: false } }, { text: '¿Seguro?' });
await call(h2(a2), { body: { turns } });
assert.ok(!log.some((l) => l.startsWith('DELETE')));
assert.match(JSON.stringify(a2.seen[1].contents.at(-1)), /confirmaci/);
a2 = script({ call: 'delete_entry', args: { id: 'abcd1234', confirmed: true } }, { text: 'Eliminado.' });
r = await call(h2(a2), { body: { turns } });
assert.ok(log.some((l) => l.startsWith('DELETE entries?id=eq.abcd1234')));
assert.equal(r.body.saved[0].title, 'Eliminado: Gases');

// buscar
log.length = 0;
a2 = script({ call: 'search_entries', args: { type: 'symptom', from: '2026-10-01', text: 'gases; drop' } }, { text: 'Encontré uno.' });
await call(h2(a2), { body: { turns } });
const g = log.find((l) => l.startsWith('GET entries?select=id,type'));
assert.ok(g.includes('type=eq.symptom') && g.includes('date=gte.2026-10-01') && g.includes('title.ilike.*gases drop*'));

// plan: cambia pavita y agrega pescado como versión nueva
log.length = 0;
a2 = script({ call: 'update_food_plan', args: { changes: [{ id: 'pavo', qty: 240 }], add_items: [{ id: 'pescado', group: 'Proteína', name: 'Pescado blanco (tilapia)', qty: 300, unit: 'g', freq: '2 días a la semana' }] } }, { text: 'Plan actualizado.' });
r = await call(h2(a2), { body: { turns } });
const post = log.find((l) => l.startsWith('POST entries'));
const row = JSON.parse(post.slice(post.indexOf('{')));
assert.equal(row.detail.status, 'plan'); assert.equal(row.plan.items[0].qty, 240); assert.equal(row.plan.items[1].id, 'pescado'); assert.equal(plan.plan.items[0].qty, 160);
// ítem inexistente → error sin guardar
log.length = 0;
a2 = script({ call: 'update_food_plan', args: { changes: [{ id: 'zzz', qty: 5 }] } }, { text: 'No pude.' });
await call(h2(a2), { body: { turns } });
assert.ok(!log.some((l) => l.startsWith('POST')));
console.log('chat.test OK');
