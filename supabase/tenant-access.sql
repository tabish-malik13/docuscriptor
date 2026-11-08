-- Tenant authority. No users, tenants, memberships or invitations are seeded.
-- Run as the migration owner on a Supabase project. Private helpers are not Data API schemas.
begin;
create schema if not exists docuscripter_private;
revoke all on schema docuscripter_private from public, anon;
grant usage on schema docuscripter_private to authenticated;

create table public.ds_tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  slug text not null constraint ds_tenants_slug_key unique
    check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' and slug not in ('www','app','api','auth','admin','login','signup','register','mail','support','help','docs','status','static','assets','editor','dashboard','billing','security')),
  created_at timestamptz not null default now()
);
create table public.ds_memberships (
  tenant_id uuid not null references public.ds_tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','operator','viewer')),
  email text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id,user_id)
);
create index ds_memberships_user_idx on public.ds_memberships(user_id,tenant_id);
-- This invariant also applies when Auth deletes a user and cascades membership removal.
create function docuscripter_private.keep_last_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_removes_owner boolean;
begin
  if tg_op='DELETE' then v_removes_owner := old.role='owner';
  else v_removes_owner := old.role='owner' and new.role is distinct from 'owner'; end if;
  if v_removes_owner then
    perform 1 from public.ds_tenants where id=old.tenant_id for update;
    if found and (select count(*) from public.ds_memberships where tenant_id=old.tenant_id and role='owner')<=1 then
      raise exception 'A tenant must retain at least one owner' using errcode='23514';
    end if;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
create trigger ds_keep_last_owner before delete or update on public.ds_memberships
  for each row execute function docuscripter_private.keep_last_owner();
create table public.ds_invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ds_tenants(id) on delete cascade,
  tenant_name text not null,
  email text not null check (length(email) <= 254 and email = lower(btrim(email))),
  role text not null check (role in ('admin','operator','viewer')),
  invited_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at timestamptz
);
create index ds_invitations_tenant_idx on public.ds_invitations(tenant_id,created_at desc);
create index ds_invitations_email_idx on public.ds_invitations(email) where accepted_at is null and revoked_at is null;
create index ds_invitations_invited_by_idx on public.ds_invitations(invited_by);
create table public.ds_audit_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.ds_tenants(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index ds_audit_tenant_idx on public.ds_audit_events(tenant_id,created_at desc,id desc);
create index ds_audit_actor_idx on public.ds_audit_events(actor_id);

alter table public.ds_tenants enable row level security;
alter table public.ds_memberships enable row level security;
alter table public.ds_invitations enable row level security;
alter table public.ds_audit_events enable row level security;
revoke all on public.ds_tenants,public.ds_memberships,public.ds_invitations,public.ds_audit_events from public,anon,authenticated;
grant select on public.ds_tenants,public.ds_memberships,public.ds_invitations,public.ds_audit_events to authenticated;

create function docuscripter_private.verified_email() returns text
language sql stable security definer set search_path = '' as $$
  select lower(u.email) from auth.users u
  where u.id = (select auth.uid()) and u.email_confirmed_at is not null
    and not coalesce(u.is_anonymous,false)
$$;
create function docuscripter_private.tenant_role(p_tenant_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.ds_memberships m
  where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid())
    and docuscripter_private.verified_email() is not null
$$;
create policy ds_tenants_read on public.ds_tenants for select to authenticated
  using (docuscripter_private.tenant_role(id) is not null);
create policy ds_memberships_read on public.ds_memberships for select to authenticated
  using (user_id = (select auth.uid()) or docuscripter_private.tenant_role(tenant_id) in ('owner','admin'));
create policy ds_invitations_read on public.ds_invitations for select to authenticated
  using (docuscripter_private.tenant_role(tenant_id) in ('owner','admin') or
    (email = (select docuscripter_private.verified_email()) and accepted_at is null and revoked_at is null and expires_at > now()));
create policy ds_audit_read on public.ds_audit_events for select to authenticated
  using (docuscripter_private.tenant_role(tenant_id) in ('owner','admin'));

create function docuscripter_private.create_tenant(p_name text,p_slug text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_email text := docuscripter_private.verified_email();
begin
  if auth.uid() is null or v_email is null then raise exception 'Verify your email before creating a tenant' using errcode='42501'; end if;
  if length(btrim(p_name)) not between 1 and 120 or p_name is null then raise exception 'Enter a tenant name of 1 to 120 characters' using errcode='22023'; end if;
  perform 1 from auth.users where id = auth.uid() for update;
  if (select count(*) from public.ds_memberships where user_id=auth.uid() and role='owner') >= 10 then
    raise exception 'Tenant ownership limit reached' using errcode='23514';
  end if;
  insert into public.ds_tenants(name,slug) values(btrim(p_name),p_slug) returning id into v_id;
  insert into public.ds_memberships(tenant_id,user_id,role,email) values(v_id,auth.uid(),'owner',v_email);
  insert into public.ds_audit_events(tenant_id,actor_id,action) values(v_id,auth.uid(),'tenant.created');
  return jsonb_build_object('id',v_id,'name',btrim(p_name),'slug',p_slug,'role','owner');
end $$;

create function docuscripter_private.rename_tenant(p_tenant_id uuid,p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.ds_tenants where id=p_tenant_id for update;
  if coalesce(docuscripter_private.tenant_role(p_tenant_id),'') not in ('owner','admin') then raise exception 'Tenant administrator access required' using errcode='42501'; end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 120 then raise exception 'Enter a tenant name of 1 to 120 characters' using errcode='22023'; end if;
  update public.ds_tenants set name=btrim(p_name) where id=p_tenant_id;
  insert into public.ds_audit_events(tenant_id,actor_id,action) values(p_tenant_id,auth.uid(),'tenant.renamed');
end $$;

create function docuscripter_private.invite_member(p_tenant_id uuid,p_email text,p_role text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_email text := lower(btrim(p_email));
begin
  perform 1 from public.ds_tenants where id=p_tenant_id for update;
  if coalesce(docuscripter_private.tenant_role(p_tenant_id),'') not in ('owner','admin') then raise exception 'Tenant administrator access required' using errcode='42501'; end if;
  if p_role is null or p_role not in ('admin','operator','viewer') then raise exception 'Choose an invitation role' using errcode='22023'; end if;
  if v_email is null or length(v_email)>254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid email address' using errcode='22023'; end if;
  if exists(select 1 from public.ds_memberships m join auth.users u on u.id=m.user_id where m.tenant_id=p_tenant_id and lower(u.email)=v_email) then raise exception 'This person is already a member' using errcode='23505'; end if;
  if (select count(*) from public.ds_invitations where tenant_id=p_tenant_id and accepted_at is null and revoked_at is null and expires_at>now()) >= 100 then raise exception 'Pending invitation limit reached' using errcode='23514'; end if;
  update public.ds_invitations set revoked_at=now() where tenant_id=p_tenant_id and email=v_email and accepted_at is null and revoked_at is null;
  insert into public.ds_invitations(tenant_id,tenant_name,email,role,invited_by) select p_tenant_id,name,v_email,p_role,auth.uid() from public.ds_tenants where id=p_tenant_id returning id into v_id;
  insert into public.ds_audit_events(tenant_id,actor_id,action,target_id,details) values(p_tenant_id,auth.uid(),'invitation.created',v_id,jsonb_build_object('role',p_role));
  return v_id;
end $$;

create function docuscripter_private.accept_invitation(p_invitation_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_inv public.ds_invitations; v_email text := docuscripter_private.verified_email(); v_tenant_id uuid;
begin
  if auth.uid() is null or v_email is null then raise exception 'Verify your email before accepting an invitation' using errcode='42501'; end if;
  select tenant_id into v_tenant_id from public.ds_invitations where id=p_invitation_id;
  perform 1 from public.ds_tenants where id=v_tenant_id for update;
  select * into v_inv from public.ds_invitations where id=p_invitation_id for update;
  if v_inv.id is null or v_inv.email<>v_email or v_inv.accepted_at is not null or v_inv.revoked_at is not null or v_inv.expires_at<=now() then raise exception 'Invitation unavailable' using errcode='42501'; end if;
  if (select count(*) from public.ds_memberships where tenant_id=v_inv.tenant_id) >= 100 then raise exception 'Tenant member limit reached' using errcode='23514'; end if;
  -- Never replace an existing role when accepting an old invitation.
  insert into public.ds_memberships(tenant_id,user_id,role,email) values(v_inv.tenant_id,auth.uid(),v_inv.role,v_email) on conflict do nothing;
  update public.ds_invitations set accepted_at=now() where id=p_invitation_id;
  insert into public.ds_audit_events(tenant_id,actor_id,action,target_id) values(v_inv.tenant_id,auth.uid(),'invitation.accepted',p_invitation_id);
  return v_inv.tenant_id;
end $$;

create function docuscripter_private.revoke_invitation(p_tenant_id uuid,p_invitation_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.ds_tenants where id=p_tenant_id for update;
  if coalesce(docuscripter_private.tenant_role(p_tenant_id),'') not in ('owner','admin') then raise exception 'Tenant administrator access required' using errcode='42501'; end if;
  update public.ds_invitations set revoked_at=now() where tenant_id=p_tenant_id and id=p_invitation_id and accepted_at is null and revoked_at is null;
  if not found then raise exception 'Invitation unavailable' using errcode='P0002'; end if;
  insert into public.ds_audit_events(tenant_id,actor_id,action,target_id) values(p_tenant_id,auth.uid(),'invitation.revoked',p_invitation_id);
end $$;

create function docuscripter_private.set_member_role(p_tenant_id uuid,p_user_id uuid,p_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_actor text; v_target text;
begin
  -- Serialize all membership mutations on the tenant, including last-owner checks.
  perform 1 from public.ds_tenants where id=p_tenant_id for update;
  v_actor := docuscripter_private.tenant_role(p_tenant_id);
  select role into v_target from public.ds_memberships where tenant_id=p_tenant_id and user_id=p_user_id;
  if v_actor is null or (v_actor not in ('owner','admin') and not (p_user_id=auth.uid() and p_role is null)) then raise exception 'Tenant administrator access required' using errcode='42501'; end if;
  if v_target is null then raise exception 'Member not found' using errcode='P0002'; end if;
  if p_role is not null and p_role not in ('owner','admin','operator','viewer') then raise exception 'Choose a valid role' using errcode='22023'; end if;
  if (v_target='owner' or p_role='owner') and v_actor<>'owner' then raise exception 'Only an owner can change ownership' using errcode='42501'; end if;
  if v_target='owner' and p_role is distinct from 'owner' and (select count(*) from public.ds_memberships where tenant_id=p_tenant_id and role='owner')<=1 then raise exception 'A tenant must retain at least one owner' using errcode='23514'; end if;
  if p_role is null then
    delete from public.ds_memberships where tenant_id=p_tenant_id and user_id=p_user_id;
    -- An old pending invitation must not restore a removed user's membership.
    update public.ds_invitations set revoked_at=now() where tenant_id=p_tenant_id and accepted_at is null and revoked_at is null and email in(select lower(email) from auth.users where id=p_user_id);
  else
    update public.ds_memberships set role=p_role where tenant_id=p_tenant_id and user_id=p_user_id;
  end if;
  insert into public.ds_audit_events(tenant_id,actor_id,action,target_id,details) values(p_tenant_id,auth.uid(),case when p_role is null then 'member.removed' else 'member.role_changed' end,p_user_id,jsonb_build_object('role',p_role));
end $$;

-- Exposed RPC wrappers run as the caller. Privileged implementations remain outside exposed schemas.
create function public.ds_create_tenant(p_name text,p_slug text) returns jsonb language sql security invoker set search_path = '' as $$ select docuscripter_private.create_tenant(p_name,p_slug) $$;
create function public.ds_rename_tenant(p_tenant_id uuid,p_name text) returns void language sql security invoker set search_path = '' as $$ select docuscripter_private.rename_tenant(p_tenant_id,p_name) $$;
create function public.ds_invite_member(p_tenant_id uuid,p_email text,p_role text) returns uuid language sql security invoker set search_path = '' as $$ select docuscripter_private.invite_member(p_tenant_id,p_email,p_role) $$;
create function public.ds_accept_invitation(p_invitation_id uuid) returns uuid language sql security invoker set search_path = '' as $$ select docuscripter_private.accept_invitation(p_invitation_id) $$;
create function public.ds_revoke_invitation(p_tenant_id uuid,p_invitation_id uuid) returns void language sql security invoker set search_path = '' as $$ select docuscripter_private.revoke_invitation(p_tenant_id,p_invitation_id) $$;
create function public.ds_set_member_role(p_tenant_id uuid,p_user_id uuid,p_role text) returns void language sql security invoker set search_path = '' as $$ select docuscripter_private.set_member_role(p_tenant_id,p_user_id,p_role) $$;

revoke all on all functions in schema docuscripter_private from public,anon,authenticated,service_role;
grant execute on all functions in schema docuscripter_private to authenticated;
revoke all on function docuscripter_private.keep_last_owner() from public,anon,authenticated,service_role;
revoke all on function public.ds_create_tenant(text,text),public.ds_rename_tenant(uuid,text),public.ds_invite_member(uuid,text,text),public.ds_accept_invitation(uuid),public.ds_revoke_invitation(uuid,uuid),public.ds_set_member_role(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.ds_create_tenant(text,text),public.ds_rename_tenant(uuid,text),public.ds_invite_member(uuid,text,text),public.ds_accept_invitation(uuid),public.ds_revoke_invitation(uuid,uuid),public.ds_set_member_role(uuid,uuid,text) to authenticated;
notify pgrst, 'reload schema';
commit;
