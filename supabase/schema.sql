-- Diario de Brownie · esquema de Supabase
-- Pégalo completo en Supabase > SQL Editor > Run.

create table if not exists public.members (
  email text primary key            -- correos que pueden ver y escribir en el diario
);

create table if not exists public.entries (
  id         text primary key default gen_random_uuid()::text,
  type       text not null,                          -- poop, food, mood, med, exam, symptom, weight, vet, other
  date       text not null,                          -- YYYY-MM-DD
  time       text not null default '',               -- HH:MM o vacío
  title      text not null default '',
  detail     jsonb not null default '{}'::jsonb,
  note       text not null default '',
  alert      text not null default '',
  raw        text not null default '',
  labs       jsonb,                                  -- valores de laboratorio de un examen
  plan       jsonb,                                  -- plan de alimentación (solo en la entrada del plan)
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  at         text not null                           -- date + 'T' + (time o 00:00), para ordenar
);
create index if not exists entries_at_idx on public.entries (at desc);

-- ¿El usuario que llama está en la lista de miembros?
create or replace function public.is_member() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.members where lower(email) = lower(auth.jwt() ->> 'email'));
$$;
grant execute on function public.is_member() to authenticated;

alter table public.members enable row level security;   -- sin políticas: nadie la lee desde la web
alter table public.entries enable row level security;

drop policy if exists "miembros leen" on public.entries;
drop policy if exists "miembros insertan" on public.entries;
drop policy if exists "miembros actualizan" on public.entries;
drop policy if exists "miembros borran" on public.entries;
create policy "miembros leen"       on public.entries for select to authenticated using (public.is_member());
create policy "miembros insertan"   on public.entries for insert to authenticated with check (public.is_member());
create policy "miembros actualizan" on public.entries for update to authenticated using (public.is_member()) with check (public.is_member());
create policy "miembros borran"     on public.entries for delete to authenticated using (public.is_member());

-- Cambios en vivo en la página
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'entries') then
    alter publication supabase_realtime add table public.entries;
  end if;
end $$;

-- Después de correr esto, agrega tu correo (y el de quien vaya a registrar):
-- insert into public.members (email) values ('tu-correo@ejemplo.com');
