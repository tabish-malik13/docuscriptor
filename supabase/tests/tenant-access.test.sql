-- Isolated SQL integration tests. Every fixture and helper is rolled back.
-- Load tenant-access.sql first. Do not run bootstrap.sql in a real Supabase project.
begin;
create function public.ds_test_assert(p_condition boolean,p_message text) returns void
language plpgsql security invoker set search_path='' as $$
begin
  if p_condition is distinct from true then raise exception 'Tenant test failed: %',p_message; end if;
end $$;
create function public.ds_test_error(p_query text,p_state text) returns void
language plpgsql security invoker set search_path='' as $$
begin
  begin execute p_query;
  exception when others then
    if sqlstate=p_state then return; end if;
    raise;
  end;
  raise exception 'Expected SQLSTATE % for %',p_state,p_query;
end $$;

select public.ds_test_assert((select count(*)=4 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('ds_tenants','ds_memberships','ds_invitations','ds_audit_events') and c.relrowsecurity),'RLS enabled on every tenant table');
select public.ds_test_assert(not has_function_privilege('anon','public.ds_create_tenant(text,text)','execute'),'anonymous creation denied');
select public.ds_test_assert(not has_function_privilege('service_role','public.ds_create_tenant(text,text)','execute'),'service key not needed for tenant RPCs');
select public.ds_test_assert(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'ds_%' and p.prosecdef),'no privileged RPCs in exposed schema');

select set_config('test.owner',gen_random_uuid()::text,true);
select set_config('test.admin',gen_random_uuid()::text,true);
select set_config('test.viewer',gen_random_uuid()::text,true);
select set_config('test.other',gen_random_uuid()::text,true);
select set_config('test.unverified',gen_random_uuid()::text,true);
insert into auth.users(id,email,email_confirmed_at)
select current_setting('test.'||name)::uuid,current_setting('test.'||name)||'@test.invalid',case when name='unverified' then null else now() end
from unnest(array['owner','admin','viewer','other','unverified']) name;

set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.unverified'),'role','authenticated')::text,true);
select public.ds_test_error($q$select public.ds_create_tenant('Denied','denied-workspace')$q$,'42501');
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.owner'),'role','authenticated')::text,true);
select set_config('test.tenant_a',(public.ds_create_tenant('Organization A verification','organization-a')->>'id'),true);
select public.ds_test_assert(docuscripter_private.tenant_role(current_setting('test.tenant_a')::uuid)='owner','creator receives ownership');
select public.ds_test_error($q$select public.ds_set_member_role(current_setting('test.tenant_a')::uuid,current_setting('test.owner')::uuid,null)$q$,'23514');
select set_config('test.invite_admin',public.ds_invite_member(current_setting('test.tenant_a')::uuid,current_setting('test.admin')||'@test.invalid','admin')::text,true);
select set_config('test.invite_viewer',public.ds_invite_member(current_setting('test.tenant_a')::uuid,current_setting('test.viewer')||'@test.invalid','viewer')::text,true);
select public.ds_test_assert((select count(*)=2 from public.ds_invitations),'administrator can view pending invitations');
select public.ds_test_error($q$update public.ds_memberships set role='viewer'$q$,'42501');

select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.other'),'role','authenticated')::text,true);
select set_config('test.tenant_b',(public.ds_create_tenant('Organization B verification','organization-b')->>'id'),true);
select public.ds_test_assert((select count(*)=1 from public.ds_tenants),'other tenant is hidden by RLS');
select public.ds_test_assert(not exists(select 1 from public.ds_tenants where id=current_setting('test.tenant_a')::uuid),'tenant A inaccessible to tenant B owner');
select public.ds_test_assert((select count(*)=0 from public.ds_invitations),'unaddressed invitations are hidden');
select public.ds_test_error($q$select public.ds_accept_invitation(current_setting('test.invite_viewer')::uuid)$q$,'42501');
select public.ds_test_error($q$select public.ds_rename_tenant(current_setting('test.tenant_a')::uuid,'Denied')$q$,'42501');

select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.viewer'),'role','authenticated')::text,true);
select public.ds_test_assert((select count(*)=1 from public.ds_invitations),'recipient can see only their own invitation');
select public.ds_accept_invitation(current_setting('test.invite_viewer')::uuid);
select public.ds_test_assert(docuscripter_private.tenant_role(current_setting('test.tenant_a')::uuid)='viewer','accepted role belongs to that tenant');
select public.ds_test_assert((select count(*)=1 from public.ds_memberships),'viewer cannot list other members');
select public.ds_test_assert((select count(*)=0 from public.ds_audit_events),'viewer cannot read administrator audit');
select public.ds_test_error($q$select public.ds_invite_member(current_setting('test.tenant_a')::uuid,'blocked@test.invalid','owner')$q$,'42501');
select public.ds_test_error($q$select public.ds_set_member_role(current_setting('test.tenant_a')::uuid,current_setting('test.viewer')::uuid,'owner')$q$,'42501');

select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.admin'),'role','authenticated')::text,true);
select public.ds_accept_invitation(current_setting('test.invite_admin')::uuid);
select public.ds_rename_tenant(current_setting('test.tenant_a')::uuid,'Renamed tenant');
select public.ds_test_assert((select count(*)=3 from public.ds_memberships),'admin can list tenant members');
select public.ds_test_error($q$select public.ds_set_member_role(current_setting('test.tenant_a')::uuid,current_setting('test.admin')::uuid,'owner')$q$,'42501');
select public.ds_test_error($q$select public.ds_set_member_role(current_setting('test.tenant_a')::uuid,current_setting('test.owner')::uuid,'viewer')$q$,'42501');
select set_config('test.expiring_invite',public.ds_invite_member(current_setting('test.tenant_a')::uuid,current_setting('test.other')||'@test.invalid','operator')::text,true);
select set_config('test.revoked_invite',public.ds_invite_member(current_setting('test.tenant_a')::uuid,current_setting('test.unverified')||'@test.invalid','viewer')::text,true);
select public.ds_revoke_invitation(current_setting('test.tenant_a')::uuid,current_setting('test.revoked_invite')::uuid);
reset role;
update public.ds_invitations set expires_at=now()-interval '1 second' where id=current_setting('test.expiring_invite')::uuid;
set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.other'),'role','authenticated')::text,true);
select public.ds_test_error($q$select public.ds_accept_invitation(current_setting('test.expiring_invite')::uuid)$q$,'42501');
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.unverified'),'role','authenticated')::text,true);
select public.ds_test_error($q$select public.ds_accept_invitation(current_setting('test.revoked_invite')::uuid)$q$,'42501');

select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.owner'),'role','authenticated')::text,true);
select public.ds_set_member_role(current_setting('test.tenant_a')::uuid,current_setting('test.admin')::uuid,'owner');
select public.ds_set_member_role(current_setting('test.tenant_a')::uuid,current_setting('test.owner')::uuid,null);
select public.ds_test_assert(docuscripter_private.tenant_role(current_setting('test.tenant_a')::uuid) is null,'removed owner immediately loses membership');
select public.ds_test_assert((select count(*)=0 from public.ds_tenants),'removed owner cannot read former tenant');
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.admin'),'role','authenticated')::text,true);
select public.ds_set_member_role(current_setting('test.tenant_a')::uuid,current_setting('test.viewer')::uuid,null);
select public.ds_test_assert((select count(*)>0 from public.ds_audit_events),'owner can read access audit');
reset role;
select public.ds_test_error($q$delete from auth.users where id=current_setting('test.admin')::uuid$q$,'23514');
select public.ds_test_error($q$update public.ds_memberships set role='viewer' where tenant_id=current_setting('test.tenant_a')::uuid and user_id=current_setting('test.admin')::uuid$q$,'23514');
rollback;
