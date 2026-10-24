# Contexto para futuras sesiones (Claude)

Proyecto: diario de salud de Brownie (schnauzer estándar, 6 años, hembra esterilizada, colecistectomía ago-2024, alergia reportada al pollo). Usuaria: Kim (Lima, UTC-5), habla español.

- Sin build. `public/index.html` es una sola página con JS propio; `public/shim.js` emula la API `window.claude` (db/user/downloads/sample) sobre Supabase y `/api/chat`.
- Esquema de registro: `{type, date, time, title, detail, note, alert, raw, labs?, plan?, created_at, at}`. Tipos: poop, food, mood, med, exam, symptom, weight, vet, other. En la página el campo se llama `createdAt` (el shim lo mapea a `created_at`).
- Plan de alimentos: registro `food` con `detail.status='plan'` y `plan.items[{id,group,name,qty,unit,freq,split,note}]`. Checklist: `type:'other'`, `detail:{kind:'check', item, what, amount, given?}`.
- Dosis de medicinas: `type:'med'`, `detail.kind='dose'`. Planes de medicina: `detail.kind='plan'`.
- El chat: el cliente manda el contexto (últimos 14 días + exámenes) como primer turno; las reglas viven en `api/_rules.js`.
- Datos de salud reales NO van al repo (`brownie-seed.sql` está en .gitignore).
- Tareas complejas (PDFs de exámenes, cambios grandes) se hacen en conversación con Claude y se suben aquí.
- Pendiente de confirmar con Kim: dosis de trilostano vs Proteliv (0.2 ml / 0.5 ml). Para el veterinario, sin interpretar: páncreas izq/der distinto en eco de octubre; ecogenicidad hepática "aumentada" (feb/may) vs "disminuida" (oct); el plan dice "Sexo: M".
