-- Shared worker availability and private business shortlists.
create table public.cistyr_worker_availability (
  worker_id uuid primary key references public.cistyr_profiles(id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 100),
  zip_code text not null check (zip_code ~ '^[0-9]{5}$'),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  is_available boolean not null default true
);
alter table public.cistyr_worker_availability enable row level security;
revoke all on public.cistyr_worker_availability from anon, authenticated;
grant select, insert, update, delete on public.cistyr_worker_availability to authenticated;
create policy "Workers see own availability and businesses see available workers"
on public.cistyr_worker_availability for select to authenticated using (
  worker_id = (select auth.uid()) or (is_available and exists (
    select 1 from public.cistyr_profiles where id = (select auth.uid()) and role = 'business'
  ))
);
create policy "Workers insert own availability" on public.cistyr_worker_availability
for insert to authenticated with check (
  worker_id = (select auth.uid()) and exists (
    select 1 from public.cistyr_profiles where id = (select auth.uid()) and role = 'worker'
  )
);
create policy "Workers update own availability" on public.cistyr_worker_availability
for update to authenticated using (worker_id = (select auth.uid())) with check (
  worker_id = (select auth.uid()) and exists (
    select 1 from public.cistyr_profiles where id = (select auth.uid()) and role = 'worker'
  )
);
create policy "Workers remove own availability" on public.cistyr_worker_availability
for delete to authenticated using (worker_id = (select auth.uid()));
create index cistyr_available_location_idx on public.cistyr_worker_availability(latitude,longitude) where is_available;

create table public.cistyr_worker_shortlist (
  business_id uuid not null references public.cistyr_profiles(id) on delete cascade,
  worker_id uuid not null references public.cistyr_profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (business_id,worker_id)
);
alter table public.cistyr_worker_shortlist enable row level security;
revoke all on public.cistyr_worker_shortlist from anon, authenticated;
grant select, insert, delete on public.cistyr_worker_shortlist to authenticated;
create policy "Businesses read own shortlist" on public.cistyr_worker_shortlist
for select to authenticated using (business_id = (select auth.uid()));
create policy "Businesses select available workers" on public.cistyr_worker_shortlist
for insert to authenticated with check (
  business_id = (select auth.uid()) and exists (
    select 1 from public.cistyr_profiles where id = (select auth.uid()) and role = 'business'
  ) and exists (
    select 1 from public.cistyr_worker_availability a where a.worker_id = cistyr_worker_shortlist.worker_id and a.is_available
  )
);
create policy "Businesses remove own selections" on public.cistyr_worker_shortlist
for delete to authenticated using (business_id = (select auth.uid()));
