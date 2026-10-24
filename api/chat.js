// POST /api/chat  ->  { text, saved: [{id,title,type}] }
// Cuerpo: { turns: [{role:'user'|'assistant', content:string}, ...] }  (el primer turno lleva el contexto del diario)
import { GoogleGenAI } from '@google/genai';
import { CHAT_RULES } from './_rules.js';

const TYPES = ['poop', 'food', 'mood', 'med', 'exam', 'symptom', 'weight', 'vet', 'other'];
const MAX_TURNS = 14, MAX_CHARS = 16000, MAX_ROUNDS = 4;
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
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const out = await client.models.generateContent({
          model, contents,
          config: { systemInstruction: CHAT_RULES, tools: [{ functionDeclarations: [SAVE_DECL] }], temperature: 0.3 }
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
          if (fc.name !== 'save_entry') result = { error: 'herramienta desconocida' };
          else {
            try {
              const row = cleanEntry(fc.args || {});
              const r = await fetchFn(SB + '/rest/v1/entries', { method: 'POST', headers: { ...sbHeaders, Prefer: 'return=representation' }, body: JSON.stringify(row) });
              if (!r.ok) throw new Error('No se pudo guardar (' + r.status + ')');
              const rows = await r.json();
              const id = rows && rows[0] && rows[0].id;
              saved.push({ id, title: row.title, type: row.type });
              result = { ok: true, id };
            } catch (e) { result = { error: String(e.message || e) }; }
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
