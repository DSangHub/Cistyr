-- Keep custom AI chat bounded; the three built-in FAQ answers do not use this quota.
create table public.cistyr_job_help_quota (
  worker_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0
);
alter table public.cistyr_job_help_quota enable row level security;
revoke all on public.cistyr_job_help_quota from anon, authenticated;

create or replace function public.cistyr_take_job_help_quota(p_worker_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.cistyr_job_help_quota as q(worker_id,window_started_at,request_count)
  values(p_worker_id,now(),1)
  on conflict (worker_id) do update set
    window_started_at = case
      when q.window_started_at < now() - interval '1 hour' then now()
      else q.window_started_at end,
    request_count = case
      when q.window_started_at < now() - interval '1 hour' then 1
      else q.request_count + 1 end
  where q.window_started_at < now() - interval '1 hour'
     or q.request_count < 20
  returning request_count into n;
  return n is not null;
end $$;
revoke all on function public.cistyr_take_job_help_quota(uuid) from public, anon, authenticated;
grant execute on function public.cistyr_take_job_help_quota(uuid) to service_role;
