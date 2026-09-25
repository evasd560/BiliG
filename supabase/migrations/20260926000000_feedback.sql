-- Feedback from the flag icons: one on each flashcard, one at the end of the page.
--
-- Anyone (visitors with the public key included) can SEND feedback; nobody can read it
-- through the API. Read it in the Supabase dashboard (Table editor → feedback).
-- phrase_id / phrase_text are filled when the feedback was flagged from a card.
--
-- To undo:  drop table public.feedback;

create table if not exists public.feedback (
  id          bigint generated always as identity primary key,
  message     text not null check (char_length(message) between 1 and 2000),
  phrase_id   text,
  phrase_text text,
  page        text,
  user_id     uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

alter table public.feedback enable row level security;

grant insert on public.feedback to anon, authenticated;

drop policy if exists "anyone can send feedback" on public.feedback;
create policy "anyone can send feedback"
  on public.feedback for insert to anon, authenticated with check (true);
