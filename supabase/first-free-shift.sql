-- Apply in the CISTYR Supabase project before deploying the updated checkout function.
create table if not exists public.cistyr_free_post_claims (
  business_id uuid primary key references auth.users(id) on delete cascade,
  shift_id uuid unique references public.cistyr_shifts(id) on delete set null,
  claimed_at timestamptz not null default now()
);
alter table public.cistyr_free_post_claims enable row level security;
revoke all on public.cistyr_free_post_claims from anon, authenticated;
grant select on public.cistyr_free_post_claims to authenticated;
create policy "Business sees own free post claim" on public.cistyr_free_post_claims
  for select to authenticated using (business_id = (select auth.uid()));

-- Only the server's service role can call this function. The lock and claim make
-- concurrent attempts atomic. Businesses with an earlier shift do not qualify.
create or replace function public.cistyr_create_first_free_shift(
  p_business_id uuid, p_category text, p_when_label text, p_start_time text,
  p_end_time text, p_time_label text, p_pay_rate numeric, p_location text,
  p_notes text, p_latitude double precision, p_longitude double precision
) returns uuid language plpgsql security definer
set search_path = '' as $$
declare v_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_business_id::text, 28472));
  if not exists (select 1 from public.cistyr_profiles where id = p_business_id and role = 'business')
     or exists (select 1 from public.cistyr_shifts where business_id = p_business_id)
     or exists (select 1 from public.cistyr_free_post_claims where business_id = p_business_id)
  then return null; end if;

  insert into public.cistyr_shifts (
    business_id, category, when_label, start_time, end_time, time_label,
    pay_rate, location, notes, latitude, longitude, status, amount_cents
  ) values (
    p_business_id, p_category, p_when_label, p_start_time, p_end_time, p_time_label,
    p_pay_rate, p_location, p_notes, p_latitude, p_longitude, 'open', 0
  ) returning id into v_id;
  insert into public.cistyr_free_post_claims (business_id, shift_id) values (p_business_id, v_id);
  return v_id;
end $$;
revoke all on function public.cistyr_create_first_free_shift(uuid,text,text,text,text,text,numeric,text,text,double precision,double precision) from public, anon, authenticated;
grant execute on function public.cistyr_create_first_free_shift(uuid,text,text,text,text,text,numeric,text,text,double precision,double precision) to service_role;
