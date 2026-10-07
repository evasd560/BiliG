-- Errors the app hits in someone's browser, so a problem a visitor sees is not silent.
--
-- Same shape as feedback: anyone (visitors with the public key included) can REPORT an
-- error; nobody can read them back through the API. Read them in the Supabase dashboard
-- (Table editor → client_errors).
--
-- The lengths are capped so a stuck loop or a bored visitor cannot fill the table with
-- long payloads; the app also caps how many it sends per page load.
--
-- To undo:  drop table public.client_errors;

create table if not exists public.client_errors (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('render','error','unhandledrejection')),
  message     text not null check (char_length(message) between 1 and 500),
  stack       text check (char_length(stack) <= 4000),
  page        text check (char_length(page) <= 300),
  user_agent  text check (char_length(user_agent) <= 300),
  user_id     uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists client_errors_recent on public.client_errors (created_at desc);

alter table public.client_errors enable row level security;

grant insert on public.client_errors to anon, authenticated;

drop policy if exists "anyone can report an error" on public.client_errors;
create policy "anyone can report an error"
  on public.client_errors for insert to anon, authenticated with check (true);
