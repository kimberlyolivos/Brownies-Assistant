# Brownie's Assistant

Web app para registrar la salud de Brownie (popó, comida, medicinas, exámenes, peso, veterinario) con un chat que registra por ti.

- **Vercel**: sirve la página (`public/`) y la función del chat (`api/chat.js`).
- **Supabase**: base de datos (`entries`) + inicio de sesión con enlace al correo. Solo entran los correos de la tabla `members`.
- **Gemini API**: el chat. La clave vive solo en Vercel, nunca en la página.

## Puesta en marcha (≈20 min)

### 1. Supabase
1. Crea un proyecto en supabase.com (plan gratis).
2. **SQL Editor** → pega `supabase/schema.sql` → Run.
3. En el mismo editor corre: `insert into public.members (email) values ('tu-correo@gmail.com');` (uno por cada persona que podrá entrar).
4. (Opcional) Pega y corre `brownie-seed.sql` (tus datos actuales; este archivo NO va a GitHub).
5. **Authentication → URL Configuration**: más adelante, cuando tengas la URL de Vercel, ponla en *Site URL* y en *Redirect URLs*.
6. **Project Settings → API**: copia *Project URL* y la clave *anon public*.

### 2. Configuración
Edita `public/config.js` con la URL y la anon key de Supabase (son públicas por diseño; la seguridad la dan las reglas RLS).

### 3. Gemini
Crea una clave en aistudio.google.com/apikey. Ojo: en el plan gratis Google puede usar lo que envíes para mejorar sus productos; el diario incluye datos de salud de la mascota. Para evitarlo, activa facturación (el costo del chat es de centavos al mes) y fija un límite de gasto.

### 4. Vercel
1. Sube este proyecto a un repo **privado** de GitHub.
2. En vercel.com → Add New Project → importa el repo (Framework: *Other*).
3. **Environment Variables**: `GEMINI_API_KEY`, `GEMINI_MODEL` (por defecto `gemini-3.5-flash-lite`), `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
4. Deploy. Copia la URL y vuelve al paso 1.5.

## Probar en local
`npm install && npm test` (prueba la función del chat con Gemini y Supabase simulados).

## Estructura
- `public/index.html`: toda la interfaz. `public/shim.js`: conecta la interfaz con Supabase y `/api/chat`.
- `api/chat.js`: valida al usuario, llama a Gemini y guarda registros con la herramienta `save_entry`. `api/_rules.js`: instrucciones del asistente.
- `supabase/schema.sql`: tablas, reglas de acceso y tiempo real.
