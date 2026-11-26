begin;

-- Recipients can read their invitation before they are allowed to read the tenant.
create or replace function docuscripter_private.refresh_invitation_name() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  update public.ds_invitations set tenant_name=new.name
  where tenant_id=new.id and accepted_at is null and revoked_at is null and expires_at>now();
  return new;
end $$;
revoke all on function docuscripter_private.refresh_invitation_name() from public,anon,authenticated,service_role;
create or replace trigger ds_refresh_invitation_name after update of name on public.ds_tenants
  for each row when (old.name is distinct from new.name)
  execute function docuscripter_private.refresh_invitation_name();

update public.ds_invitations i set tenant_name=t.name
from public.ds_tenants t
where i.tenant_id=t.id and i.tenant_name is distinct from t.name
  and i.accepted_at is null and i.revoked_at is null and i.expires_at>now();

commit;
