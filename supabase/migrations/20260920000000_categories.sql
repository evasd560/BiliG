-- Categories with an emoji each, editable from Settings.
--
-- Built-in categories (Greetings, Food, ...) keep their names; a row here just overrides their
-- emoji. Custom categories are named by the phrases that use them, and a row here gives them an
-- emoji (and lets an empty category exist). Everyone can read; only signed-in owners can change.
--
-- To undo:  drop table public.categories;

create table if not exists public.categories (
  name       text primary key,
  emoji      text not null,
  user_id    uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);

alter table public.categories enable row level security;

grant select on public.categories to anon, authenticated;
grant insert, update, delete on public.categories to authenticated;

drop policy if exists "categories are publicly readable" on public.categories;
create policy "categories are publicly readable"
  on public.categories for select to anon, authenticated using (true);

drop policy if exists "owners manage categories" on public.categories;
create policy "owners manage categories"
  on public.categories for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
