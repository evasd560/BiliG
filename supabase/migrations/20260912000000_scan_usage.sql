-- Per-caller daily scan quota.
--
-- Scanning is open to everyone, including guests who have no account, so the
-- endpoint cannot be gated on sign-in. This table bounds what any one caller can
-- spend instead. Only the service role (the scan Edge Function) touches it.

create table if not exists public.scan_usage (
  id         text primary key,            -- 'u:<user id>' or 'ip:<sha256 of ip>'
  day        date        not null default current_date,
  count      integer     not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.scan_usage enable row level security;
-- Deliberately no policies: anon and authenticated roles get no access at all.
-- The Edge Function uses the service role, which bypasses RLS.

-- Counts a scan and reports whether it was within the caller's daily allowance.
-- Atomic, so two concurrent scans can't both slip past the limit.
create or replace function public.bump_scan_usage(p_id text, p_limit integer)
returns table (allowed boolean, used integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.scan_usage as s (id, day, count)
       values (p_id, current_date, 1)
  on conflict (id) do update
       set count      = case when s.day = current_date then s.count + 1 else 1 end,
           day        = current_date,
           updated_at = now()
  returning s.count into v_count;

  return query select (v_count <= p_limit), v_count;
end;
$$;

revoke all on function public.bump_scan_usage(text, integer) from public, anon, authenticated;
