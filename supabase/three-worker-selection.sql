-- Workers apply; a business pays $6.25 to choose one of up to three applicants.
create table public.cistyr_shift_applications (
  shift_id uuid not null references public.cistyr_shifts(id) on delete cascade,
  worker_id uuid not null references auth.users(id) on delete cascade,
  applied_at timestamptz not null default now(),
  primary key (shift_id, worker_id)
);
alter table public.cistyr_shift_applications enable row level security;
grant select on public.cistyr_shift_applications to authenticated;
create policy "Applicants and posting business see applications" on public.cistyr_shift_applications
  for select to authenticated using (
    worker_id = (select auth.uid()) or exists (
      select 1 from public.cistyr_shifts s where s.id = shift_id and s.business_id = (select auth.uid())
    )
  );

create or replace function public.cistyr_apply_to_shift(p_shift_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_worker uuid := auth.uid(); v_status text;
begin
  if v_worker is null or not exists (
    select 1 from public.cistyr_profiles where id=v_worker and role='worker'
  ) then raise exception 'Worker account required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_shift_id::text, 4731));
  select status::text into v_status from public.cistyr_shifts where id=p_shift_id;
  if v_status <> 'open' or v_status is null then raise exception 'Shift is no longer open'; end if;
  if exists (select 1 from public.cistyr_shift_applications where shift_id=p_shift_id and worker_id=v_worker)
    then return 'already_applied'; end if;
  if (select count(*) from public.cistyr_shift_applications where shift_id=p_shift_id) >= 3
    then raise exception 'This shift already has three applicants'; end if;
  insert into public.cistyr_shift_applications(shift_id,worker_id) values(p_shift_id,v_worker);
  return 'applied';
end $$;
revoke all on function public.cistyr_apply_to_shift(uuid) from public, anon;
grant execute on function public.cistyr_apply_to_shift(uuid) to authenticated;

create table public.cistyr_shift_selections (
  shift_id uuid primary key references public.cistyr_shifts(id) on delete cascade,
  business_id uuid not null references auth.users(id),
  worker_id uuid not null references auth.users(id),
  stripe_session_id text unique,
  status text not null default 'pending' check (status in ('pending','paid')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  constraint selection_requires_payment check (status <> 'paid' or (paid_at is not null and stripe_session_id is not null))
);
alter table public.cistyr_shift_selections enable row level security;
grant select on public.cistyr_shift_selections to authenticated;
create policy "Business and chosen worker see selection" on public.cistyr_shift_selections
  for select to authenticated using (
    business_id=(select auth.uid()) or (worker_id=(select auth.uid()) and status='paid')
  );

-- Called by the checkout Edge Function after authenticating the business.
create or replace function public.cistyr_reserve_worker(p_shift_id uuid, p_business_id uuid, p_worker_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_status text; v_existing public.cistyr_shift_selections%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_shift_id::text, 4731));
  select status::text into v_status from public.cistyr_shifts
    where id=p_shift_id and business_id=p_business_id;
  if v_status <> 'open' or v_status is null then raise exception 'Shift is not open for this business'; end if;
  if not exists (select 1 from public.cistyr_shift_applications where shift_id=p_shift_id and worker_id=p_worker_id)
    then raise exception 'Worker did not apply to this shift'; end if;
  select * into v_existing from public.cistyr_shift_selections where shift_id=p_shift_id;
  if found then
    if v_existing.status='paid' or v_existing.worker_id<>p_worker_id
      then raise exception 'A worker selection is already in progress'; end if;
    return 'pending';
  end if;
  insert into public.cistyr_shift_selections(shift_id,business_id,worker_id)
    values(p_shift_id,p_business_id,p_worker_id);
  return 'pending';
end $$;
revoke all on function public.cistyr_reserve_worker(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.cistyr_reserve_worker(uuid,uuid,uuid) to service_role;

create or replace function public.cistyr_finish_worker_selection(
  p_shift_id uuid, p_business_id uuid, p_worker_id uuid, p_session_id text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_shift_id::text, 4731));
  select status into v_status from public.cistyr_shift_selections
    where shift_id=p_shift_id and business_id=p_business_id and worker_id=p_worker_id
      and stripe_session_id=p_session_id;
  if v_status='paid' then return true; end if;
  if v_status<>'pending' or v_status is null then return false; end if;
  update public.cistyr_shifts set status='rescued',rescuer_id=p_worker_id,paid_at=now(),
    amount_cents=625,stripe_session_id=p_session_id
    where id=p_shift_id and business_id=p_business_id and status='open';
  if not found then return false; end if;
  update public.cistyr_shift_selections set status='paid',paid_at=now()
    where shift_id=p_shift_id and status='pending';
  return true;
end $$;
revoke all on function public.cistyr_finish_worker_selection(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.cistyr_finish_worker_selection(uuid,uuid,uuid,text) to service_role;

-- Stop the old direct worker-claim update path.
drop policy if exists cistyr_shifts_update_claim on public.cistyr_shifts;

create or replace function public.cistyr_protect_shift_selection()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' and (
    new.rescuer_id is distinct from old.rescuer_id or
    new.status = 'rescued' and old.status <> 'rescued' or
    new.paid_at is distinct from old.paid_at or
    new.amount_cents is distinct from old.amount_cents or
    new.stripe_session_id is distinct from old.stripe_session_id
  ) then raise exception 'Only a verified payment can choose a worker'; end if;
  return new;
end $$;
create trigger cistyr_protect_shift_selection before update on public.cistyr_shifts
  for each row execute function public.cistyr_protect_shift_selection();
