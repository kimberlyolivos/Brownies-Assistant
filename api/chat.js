// POST /api/chat  ->  { text, saved: [{id,title,type}] }
// Cuerpo: { turns: [{role:'user'|'assistant', content:string}, ...] }  (el primer turno lleva el contexto del diario)
import { GoogleGenAI } from '@google/genai';
import { CHAT_RULES } from './_rules.js';

const TYPES = ['poop', 'food', 'mood', 'med', 'exam', 'symptom', 'weight', 'vet', 'other'];
const MAX_TURNS = 14, MAX_CHARS = 16000, MAX_ROUNDS = 6;
const hits = new Map(); // límite simple por correo (por instancia)

const SAVE_DECL = {
  name: 'save_entry',
  description: 'Guarda un registro nuevo en el diario de Brownie (popó, comida, ánimo, medicina, examen, síntoma, peso, visita al veterinario u otro). Úsalo solo cuando tengas los datos esenciales.',
  parameters: {
    type: 'OBJECT',
    properties: {
      type: { type: 'STRING', enum: TYPES },
      date: { type: 'STRING', description: 'YYYY-MM-DD' },
      time: { type: 'STRING', description: 'HH:MM, o vacío' },
      title: { type: 'STRING' },
      detail: {
        type: 'OBJECT', description: 'Detalles cortos según el tipo',
        properties: {
          consistency: { type: 'STRING' }, color: { type: 'STRING' }, blood: { type: 'BOOLEAN' }, mucus: { type: 'BOOLEAN' }, count: { type: 'NUMBER' },
          what: { type: 'STRING' }, amount: { type: 'STRING' }, appetite: { type: 'STRING' }, level: { type: 'NUMBER' },
          name: { type: 'STRING' }, dose: { type: 'STRING' }, frequency: { type: 'STRING' }, kind: { type: 'STRING' },
          status: { type: 'STRING' }, lab: { type: 'STRING' }, result: { type: 'STRING' }, kg: { type: 'NUMBER' },
          clinic: { type: 'STRING' }, reason: { type: 'STRING' }, meal: { type: 'NUMBER' }, item: { type: 'STRING' }, given: { type: 'NUMBER' }
        }
      },
      note: { type: 'STRING' }, alert: { type: 'STRING' }, raw: { type: 'STRING', description: 'La frase de Kim' }
    },
    required: ['type', 'date', 'title']
  }
};


const STR = { type: 'STRING' };
const DETAIL_SCHEMA = { type: 'OBJECT', description: 'Detalles cortos (solo los campos que cambian)' };
const TOOL_DECLS = [
  SAVE_DECL,
  {
    name: 'update_entry',
    description: 'Corrige un registro que ya existe (fecha, hora, título, nota, alerta o detalles). Usa el id corto (#xxxxxxxx) del contexto o de search_entries. Solo cambia lo que Kim pidió.',
    parameters: { type: 'OBJECT', properties: {
      id: { ...STR, description: 'Id corto o completo del registro' }, date: { ...STR, description: 'YYYY-MM-DD' }, time: { ...STR, description: 'HH:MM, o vacío' },
      title: STR, note: STR, alert: { ...STR, description: 'Texto de alerta; vacío para quitarla' }, detail: DETAIL_SCHEMA
    }, required: ['id'] }
  },
  {
    name: 'delete_entry',
    description: 'Elimina un registro. Solo con confirmed=true después de que Kim confirme explícitamente en su mensaje; antes pregúntale mostrando qué registro es.',
    parameters: { type: 'OBJECT', properties: { id: STR, confirmed: { type: 'BOOLEAN', description: 'true solo si Kim ya confirmó' } }, required: ['id', 'confirmed'] }
  },
  {
    name: 'search_entries',
    description: 'Busca en todo el historial (más allá de los últimos 14 días). Devuelve hasta 30 registros, los más recientes primero.',
    parameters: { type: 'OBJECT', properties: {
      type: { ...STR, enum: TYPES }, from: { ...STR, description: 'YYYY-MM-DD' }, to: { ...STR, description: 'YYYY-MM-DD' },
      text: { ...STR, description: 'Palabra a buscar en título o nota' }, limit: { type: 'NUMBER' }
    } }
  },
  {
    name: 'update_food_plan',
    description: 'Actualiza el plan de alimentos de la nutricionista: cambia cantidad, nombre o frecuencia de ítems existentes (por su id del plan) y/o agrega ítems nuevos. Crea una versión nueva del plan; no borra la anterior.',
    parameters: { type: 'OBJECT', properties: {
      changes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: STR, qty: { type: 'NUMBER' }, name: STR, freq: STR, note: STR }, required: ['id'] } },
      add_items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: STR, group: STR, name: STR, qty: { type: 'NUMBER' }, unit: STR, freq: STR, split: { type: 'BOOLEAN' }, note: STR }, required: ['id', 'name', 'qty', 'unit'] } }
    } }
  }
];

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

function cleanEntry(a) {
  const type = String(a.type || '');
  if (!TYPES.includes(type)) throw new Error('Tipo no válido: ' + type);
  const date = String(a.date || '');
  if (!isDate(date)) throw new Error('La fecha debe ser YYYY-MM-DD.');
  const time = /^\d{2}:\d{2}$/.test(String(a.time || '')) ? String(a.time) : '';
  const title = String(a.title || '').slice(0, 120);
  if (!title) throw new Error('Falta el título.');
  const detail = {};
  const src = a.detail && typeof a.detail === 'object' && !Array.isArray(a.detail) ? a.detail : {};
  for (const k of Object.keys(src).slice(0, 14)) {
    const v = src[k];
    if (typeof v === 'string') detail[k] = v.slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean') detail[k] = v;
  }
  return {
    type, date, time, title, detail,
    note: String(a.note || '').slice(0, 1500), alert: String(a.alert || '').slice(0, 200),
    raw: String(a.raw || '').slice(0, 400) || 'Chat en la página',
    created_at: Date.now(), at: date + 'T' + (time || '00:00')
  };
}

function json(res, code, body) { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); }

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let s = ''; for await (const c of req) s += c;
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}


const cleanDetail = (src, base = {}) => {
  const detail = { ...base };
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const k of Object.keys(src).slice(0, 14)) {
      const v = src[k];
      if (typeof v === 'string') { if (v === '') delete detail[k]; else detail[k] = v.slice(0, 200); }
      else if (typeof v === 'number' || typeof v === 'boolean') detail[k] = v;
    }
  }
  return detail;
};
const limaToday = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);

function makeTools({ SB, sbHeaders, fetchFn, saved }) {
  const rest = (method, path, body, prefer) => fetchFn(SB + '/rest/v1/' + path, { method, headers: { ...sbHeaders, ...(prefer ? { Prefer: prefer } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const need = async (r, what) => { if (!r.ok) throw new Error(what + ' (' + r.status + ')'); return r.json(); };
  async function resolve(idIn) {
    const id = String(idIn || '').trim().replace(/^#/, '');
    if (!/^[0-9a-f-]{4,36}$/i.test(id)) throw new Error('Id no válido.');
    const rows = await need(await rest('GET', 'entries?select=*&id=like.' + encodeURIComponent(id + '*') + '&limit=3'), 'No se pudo buscar');
    if (!rows.length) throw new Error('No encontré ese registro.');
    if (rows.length > 1 && id.length < 36) throw new Error('Ese id es ambiguo; busca el registro con search_entries.');
    return rows[0];
  }
  const short = (r) => ({ id: String(r.id).slice(0, 8), type: r.type, date: r.date, time: r.time || '', title: r.title, detail: r.detail, note: r.note || '', alert: r.alert || '' });
  return {
    save_entry: async (a) => {
      const row = cleanEntry(a || {});
      const rows = await need(await rest('POST', 'entries', row, 'return=representation'), 'No se pudo guardar');
      const id = rows && rows[0] && rows[0].id;
      saved.push({ id, title: row.title, type: row.type });
      return { ok: true, id };
    },
    update_entry: async (a) => {
      const cur = await resolve(a.id), patch = {};
      if (a.date !== undefined) { if (!isDate(String(a.date))) throw new Error('La fecha debe ser YYYY-MM-DD.'); patch.date = String(a.date); }
      if (a.time !== undefined) patch.time = /^\d{2}:\d{2}$/.test(String(a.time)) ? String(a.time) : '';
      if (a.title !== undefined) { const t = String(a.title).slice(0, 120); if (!t) throw new Error('El título no puede estar vacío.'); patch.title = t; }
      if (a.note !== undefined) patch.note = String(a.note).slice(0, 1500);
      if (a.alert !== undefined) patch.alert = String(a.alert).slice(0, 200);
      if (a.detail !== undefined) patch.detail = cleanDetail(a.detail, cur.detail && typeof cur.detail === 'object' ? cur.detail : {});
      if (!Object.keys(patch).length) throw new Error('No hay nada que cambiar.');
      patch.at = (patch.date || cur.date) + 'T' + ((patch.time !== undefined ? patch.time : cur.time) || '00:00');
      const rows = await need(await rest('PATCH', 'entries?id=eq.' + encodeURIComponent(cur.id), patch, 'return=representation'), 'No se pudo actualizar');
      if (!rows.length) throw new Error('No se pudo actualizar (sin permiso).');
      saved.push({ id: cur.id, title: 'Editado: ' + (patch.title || cur.title), type: cur.type });
      return { ok: true, id: String(cur.id).slice(0, 8) };
    },
    delete_entry: async (a) => {
      const cur = await resolve(a.id);
      if (a.confirmed !== true) return { error: 'Falta la confirmación de Kim. Pregúntale si está segura de eliminar "' + cur.title + '" del ' + cur.date + '.' };
      const rows = await need(await rest('DELETE', 'entries?id=eq.' + encodeURIComponent(cur.id), null, 'return=representation'), 'No se pudo eliminar');
      if (!rows.length) throw new Error('No se pudo eliminar (sin permiso).');
      saved.push({ id: cur.id, title: 'Eliminado: ' + cur.title, type: cur.type });
      return { ok: true };
    },
    search_entries: async (a) => {
      const q = ['select=id,type,date,time,title,detail,note,alert', 'order=at.desc', 'limit=' + Math.min(30, Math.max(1, Number(a.limit) || 15))];
      if (a.type) { if (!TYPES.includes(a.type)) throw new Error('Tipo no válido.'); q.push('type=eq.' + a.type); }
      if (a.from) { if (!isDate(String(a.from))) throw new Error('from debe ser YYYY-MM-DD.'); q.push('date=gte.' + a.from); }
      if (a.to) { if (!isDate(String(a.to))) throw new Error('to debe ser YYYY-MM-DD.'); q.push('date=lte.' + a.to); }
      const text = String(a.text || '').replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 40);
      if (text) q.push('or=' + encodeURIComponent('(title.ilike.*' + text + '*,note.ilike.*' + text + '*)'));
      const rows = await need(await rest('GET', 'entries?' + q.join('&')), 'No se pudo buscar');
      return { count: rows.length, entries: rows.map(short) };
    },
    update_food_plan: async (a) => {
      const rows = await need(await rest('GET', 'entries?select=*&type=eq.food&detail-%3E%3Estatus=eq.plan&order=at.desc,created_at.desc&limit=1'), 'No se pudo leer el plan');
      const cur = rows[0];
      if (!cur || !cur.plan || !Array.isArray(cur.plan.items)) throw new Error('Todavía no hay un plan de alimentos cargado.');
      const items = cur.plan.items.map((x) => ({ ...x })), done = [];
      for (const c of Array.isArray(a.changes) ? a.changes : []) {
        const it = items.find((x) => x.id === c.id);
        if (!it) throw new Error('No existe el ítem "' + c.id + '" en el plan. Ids: ' + items.map((x) => x.id).join(', '));
        if (c.qty !== undefined) { const q = Number(c.qty); if (!(q > 0 && q <= 5000)) throw new Error('Cantidad no válida.'); it.qty = q; }
        if (c.name !== undefined && String(c.name).trim()) it.name = String(c.name).trim().slice(0, 80);
        if (c.freq !== undefined && String(c.freq).trim()) it.freq = String(c.freq).trim().slice(0, 60);
        if (c.note !== undefined) it.note = String(c.note).slice(0, 160);
        done.push(it.name);
      }
      for (const n of Array.isArray(a.add_items) ? a.add_items : []) {
        const q = Number(n.qty);
        if (!/^[a-z0-9_]{2,24}$/.test(String(n.id || '')) || !(q > 0 && q <= 5000) || !String(n.name || '').trim() || !String(n.unit || '').trim()) throw new Error('Ítem nuevo no válido (id, name, qty y unit son obligatorios).');
        const k = items.findIndex((x) => x.id === n.id);
        const it = { id: n.id, group: String(n.group || 'Complementos').slice(0, 40), name: String(n.name).trim().slice(0, 80), qty: q, unit: String(n.unit).trim().slice(0, 20), freq: String(n.freq || 'diario').slice(0, 60), split: n.split === true, note: String(n.note || '').slice(0, 160) };
        if (k >= 0) items[k] = { ...items[k], ...it }; else items.push(it);
        done.push(it.name);
      }
      if (!done.length) throw new Error('No hay cambios que aplicar.');
      const date = limaToday(), now = Date.now();
      const row = { type: 'food', date, time: '', title: 'Plan de alimentación actualizado', detail: { status: 'plan' }, note: '', alert: '', raw: 'Chat en la página', plan: { ...cur.plan, items }, created_at: now, at: date + 'T00:00' };
      const out = await need(await rest('POST', 'entries', row, 'return=representation'), 'No se pudo guardar el plan');
      saved.push({ id: out && out[0] && out[0].id, title: 'Plan actualizado: ' + done.join(', '), type: 'food' });
      return { ok: true, changed: done };
    }
  };
}

export function makeHandler({ ai, fetchFn = fetch, env = process.env } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const SB = env.SUPABASE_URL, KEY = env.SUPABASE_ANON_KEY;
    if (!SB || !KEY || !env.GEMINI_API_KEY && !ai) return json(res, 500, { error: 'config', message: 'Faltan variables de entorno en Vercel.' });

    const auth = String(req.headers.authorization || '');
    const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!jwt) return json(res, 401, { error: 'auth' });
    const sbHeaders = { apikey: KEY, Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' };

    // ¿Es miembro? (Supabase valida el JWT)
    let member = false;
    try {
      const r = await fetchFn(SB + '/rest/v1/rpc/is_member', { method: 'POST', headers: sbHeaders, body: '{}' });
      member = r.ok && (await r.json()) === true;
    } catch { /* cae a no miembro */ }
    if (!member) return json(res, 403, { error: 'forbidden' });

    // límite: 30 mensajes por 10 min por token
    const now = Date.now(), k = jwt.slice(-24);
    const arr = (hits.get(k) || []).filter((t) => now - t < 600000);
    if (arr.length >= 30) return json(res, 429, { error: 'rate_limited' });
    arr.push(now); hits.set(k, arr);

    const body = await readBody(req);
    const turns = Array.isArray(body.turns) ? body.turns.slice(-MAX_TURNS) : [];
    let total = 0;
    const contents = [];
    for (const t of turns) {
      const text = String(t && t.content || '');
      total += text.length;
      if (!text) continue;
      contents.push({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
    }
    if (!contents.length || contents[contents.length - 1].role !== 'user' || total > MAX_CHARS) return json(res, 400, { error: 'bad_request' });
    if (contents[0].role !== 'user') contents.shift();

    const client = ai || new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const saved = [];
    const tools = makeTools({ SB, sbHeaders, fetchFn, saved });
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const out = await client.models.generateContent({
          model, contents,
          config: { systemInstruction: CHAT_RULES, tools: [{ functionDeclarations: TOOL_DECLS }], temperature: 0.3 }
        });
        const cand = out.candidates && out.candidates[0];
        const parts = (cand && cand.content && cand.content.parts) || [];
        const calls = parts.filter((p) => p.functionCall);
        if (!calls.length) {
          const text = parts.map((p) => p.text || '').join('').trim() || (saved.length ? 'Listo, quedó guardado.' : '');
          if (!text) return json(res, 502, { error: 'empty' });
          return json(res, 200, { text, saved });
        }
        contents.push(cand.content); // se devuelve intacto (incluye firmas de pensamiento)
        const responses = [];
        for (const p of calls) {
          const fc = p.functionCall;
          let result;
          const run = tools[fc.name];
          if (!run) result = { error: 'herramienta desconocida' };
          else {
            try { result = await run(fc.args || {}); }
            catch (e) { result = { error: String(e.message || e) }; }
          }
          responses.push({ functionResponse: { name: fc.name, response: result } });
        }
        contents.push({ role: 'user', parts: responses });
      }
      return json(res, 200, { text: saved.length ? 'Listo, quedó guardado.' : 'No pude completar eso. Prueba de nuevo.', saved });
    } catch (e) {
      const msg = String(e && e.message || e);
      const code = /429|quota|RESOURCE_EXHAUSTED/i.test(msg) ? 429 : 502;
      return json(res, code, { error: code === 429 ? 'rate_limited' : 'upstream' });
    }
  };
}

export default makeHandler();
