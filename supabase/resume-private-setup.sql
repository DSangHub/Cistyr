-- Run in the CISTYR Supabase project SQL editor before deploying the updated page.
-- Verification is granted by an administrator with SQL/service role privileges only.
create table if not exists public.cistyr_verified_businesses (
  business_id uuid primary key references auth.users(id) on delete cascade,
  verified_at timestamptz not null default now()
);
alter table public.cistyr_verified_businesses enable row level security;
revoke all on public.cistyr_verified_businesses from anon, authenticated;
grant select on public.cistyr_verified_businesses to authenticated;
create policy "Businesses see own verification" on public.cistyr_verified_businesses
  for select to authenticated using (business_id = (select auth.uid()));

create table if not exists public.cistyr_resumes (
  worker_id uuid primary key references auth.users(id) on delete cascade,
  object_path text not null unique,
  file_name text not null,
  uploaded_at timestamptz not null default now(),
  constraint resume_owner_path check (split_part(object_path, '/', 1) = worker_id::text)
);
alter table public.cistyr_resumes enable row level security;
revoke all on public.cistyr_resumes from anon, authenticated;
grant select, insert, update on public.cistyr_resumes to authenticated;
create policy "Worker reads own resume record" on public.cistyr_resumes
  for select to authenticated using (worker_id = (select auth.uid()));
create policy "Verified business reads matched worker resume record" on public.cistyr_resumes
  for select to authenticated using (
    exists (select 1 from public.cistyr_verified_businesses v where v.business_id = (select auth.uid()))
    and exists (select 1 from public.cistyr_shifts s where s.business_id = (select auth.uid()) and s.rescuer_id = worker_id and s.status = 'rescued')
  );
create policy "Worker inserts own resume record" on public.cistyr_resumes
  for insert to authenticated with check (worker_id = (select auth.uid()));
create policy "Worker updates own resume record" on public.cistyr_resumes
  for update to authenticated using (worker_id = (select auth.uid())) with check (worker_id = (select auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cistyr-resumes', 'cistyr-resumes', false, 5242880,
  array['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "Worker uploads resume in own folder" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'cistyr-resumes' and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (select 1 from public.cistyr_profiles p where p.id = (select auth.uid()) and p.role = 'worker')
  );
create policy "Worker removes own old resume" on storage.objects
  for delete to authenticated using (
    bucket_id = 'cistyr-resumes' and (storage.foldername(name))[1] = (select auth.uid())::text
  );
create policy "Owner or verified matched business downloads resume" on storage.objects
  for select to authenticated using (
    bucket_id = 'cistyr-resumes' and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or (
        storage.allow_only_operation('object.get_authenticated')
        and exists (
          select 1 from public.cistyr_resumes r
          join public.cistyr_shifts s on s.rescuer_id = r.worker_id
          join public.cistyr_verified_businesses v on v.business_id = s.business_id
          where r.object_path = name and s.business_id = (select auth.uid()) and s.status = 'rescued'
        )
      )
    )
  );

-- Example admin action after checking a business:
-- insert into public.cistyr_verified_businesses (business_id) values ('BUSINESS_USER_UUID');
