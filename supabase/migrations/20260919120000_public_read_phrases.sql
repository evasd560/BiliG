-- Shared, read-only library.
--
-- With login switched off in the app, every visitor reads the phrases with the public
-- (anon) key. This lets anyone read every row in `phrases`; it does NOT let them insert,
-- update or delete: those stay limited to signed-in owners by the existing policies.
--
-- Note: this makes ALL phrases in the table public, including any that belong to other
-- accounts. To share only one person's phrases, replace `using (true)` with
--   using (user_id = '<that user''s uuid>')
--
-- To undo:  drop policy "phrases are publicly readable" on public.phrases;

grant select on public.phrases to anon;

drop policy if exists "phrases are publicly readable" on public.phrases;
create policy "phrases are publicly readable"
  on public.phrases
  for select
  to anon
  using (true);
