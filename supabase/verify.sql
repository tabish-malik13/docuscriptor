-- Read-only deployment inspection. Expect four RLS-enabled tables.
select c.relname as table_name,c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('ds_tenants','ds_memberships','ds_invitations','ds_audit_events')
order by c.relname;
-- Expect false for every anonymous grant below.
select name as table_name,has_table_privilege('anon','public.'||name,'select') as anonymous_select
from unnest(array['ds_tenants','ds_memberships','ds_invitations','ds_audit_events']) name;
-- Expect no rows: privileged functions must never be in an exposed API schema.
select n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname like 'ds_%' and p.prosecdef;
-- Expect false: private helpers are not anonymously callable.
select has_schema_privilege('anon','docuscripter_private','usage') as anonymous_private_schema_access;
