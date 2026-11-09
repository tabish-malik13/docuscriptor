-- Private cloud documents. No application records or identities are seeded.
begin;
create table public.ds_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.ds_tenants(id),
  created_by uuid references auth.users(id) on delete set null,
  record_type text not null check(record_type in ('job','template')),
  name text not null check(length(name) between 1 and 255),
  kind text not null check(kind in ('DOCX','PDF')),
  source text not null check(length(source) between 1 and 255),
  created_at timestamptz not null default now(),
  status text not null check(status in ('processing','ready','failed','deleting')),
  error text check(length(error)<=500),
  fields jsonb not null default '[]' check(jsonb_typeof(fields)='array' and jsonb_array_length(fields)<=64),
  size_bytes bigint not null check(size_bytes between 0 and 16777216),
  sha256 text check(sha256 ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null default now()+interval '2 minutes',
  object_key text generated always as (tenant_id::text||'/'||id::text) stored unique
);
create index ds_documents_tenant_type_created on public.ds_documents(tenant_id,record_type,created_at desc,id desc);
create index ds_documents_created_by on public.ds_documents(created_by);
alter table public.ds_documents enable row level security;
revoke all on public.ds_documents from public,anon,authenticated;
grant select on public.ds_documents to authenticated;
create policy ds_documents_read on public.ds_documents for select to authenticated
using(docuscripter_private.tenant_role(tenant_id) is not null);

-- One-time migration inbox. Only administrators populate this table; a verified
-- creator can finish moving their own archived document into private Storage.
create table public.ds_document_imports (
  id uuid primary key,
  tenant_id uuid not null references public.ds_tenants(id),
  created_by uuid not null references auth.users(id),
  record_type text not null check(record_type in ('job','template')),
  metadata jsonb not null,
  file bytea,
  sha256 text
);
create index ds_document_imports_owner_tenant on public.ds_document_imports(created_by,tenant_id);
create index ds_document_imports_tenant on public.ds_document_imports(tenant_id);
alter table public.ds_document_imports enable row level security;
revoke all on public.ds_document_imports from public,anon,authenticated;
grant select,delete on public.ds_document_imports to authenticated;
create policy ds_document_imports_read on public.ds_document_imports for select to authenticated
using(created_by=(select auth.uid()) and docuscripter_private.tenant_role(tenant_id) in ('owner','admin','operator'));
create policy ds_document_imports_delete on public.ds_document_imports for delete to authenticated
using(created_by=(select auth.uid()) and docuscripter_private.tenant_role(tenant_id) in ('owner','admin','operator') and
  exists(select 1 from public.ds_documents d where d.id=ds_document_imports.id and d.tenant_id=ds_document_imports.tenant_id and
    ((d.status='ready' and d.sha256=ds_document_imports.sha256) or (d.status='failed' and ds_document_imports.file is null))));

-- Serialize reservations across organizations. Leave headroom below the free 1 GB allowance.
create table docuscripter_private.document_budget(id boolean primary key default true check(id), limit_bytes bigint not null);
insert into docuscripter_private.document_budget values(true,805306368);
alter table docuscripter_private.document_budget enable row level security;
revoke all on docuscripter_private.document_budget from public,anon,authenticated;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('ds-documents','ds-documents',false,16777216,array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create function docuscripter_private.document_object_access(p_bucket text,p_key text,p_operation text) returns boolean
language sql stable security definer set search_path='' as $$
  select p_bucket='ds-documents' and exists(
    select 1 from public.ds_documents d where d.object_key=p_key
      and docuscripter_private.tenant_role(d.tenant_id) is not null
      and case p_operation
        when 'read' then d.status='ready' or (d.status='deleting' and (d.created_by=(select auth.uid()) or docuscripter_private.tenant_role(d.tenant_id) in ('owner','admin'))) or (d.status='processing' and d.created_by=(select auth.uid()) and d.expires_at>now())
        when 'insert' then d.status='processing' and d.created_by=(select auth.uid()) and d.expires_at>now()
          and docuscripter_private.tenant_role(d.tenant_id) in ('owner','admin','operator')
        when 'delete' then d.status='deleting' and (d.created_by=(select auth.uid()) or docuscripter_private.tenant_role(d.tenant_id) in ('owner','admin'))
          and docuscripter_private.tenant_role(d.tenant_id) in ('owner','admin','operator')
        else false end)
$$;
revoke all on function docuscripter_private.document_object_access(text,text,text) from public,anon,authenticated;
grant execute on function docuscripter_private.document_object_access(text,text,text) to authenticated;
create policy ds_document_object_read on storage.objects for select to authenticated
using(docuscripter_private.document_object_access(bucket_id,name,'read'));
create policy ds_document_object_insert on storage.objects for insert to authenticated
with check(docuscripter_private.document_object_access(bucket_id,name,'insert'));
create policy ds_document_object_delete on storage.objects for delete to authenticated
using(docuscripter_private.document_object_access(bucket_id,name,'delete'));
-- No UPDATE policy: paths are immutable; uploading with upsert cannot replace a file.

create function docuscripter_private.document_command(p_tenant_id uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_role text; v_id uuid; v_type text; v_doc public.ds_documents; v_size bigint; v_limit bigint; v_fields jsonb;
begin
  -- Same lock order as membership operations; revocation and writes serialize per tenant.
  perform 1 from public.ds_tenants where id=p_tenant_id for update;
  v_role:=docuscripter_private.tenant_role(p_tenant_id);
  if coalesce(v_role,'') not in ('owner','admin','operator') then raise exception 'Document operator access required' using errcode='42501'; end if;
  select limit_bytes into v_limit from docuscripter_private.document_budget where id=true for update;
  v_id:=coalesce((p_data->>'id')::uuid,gen_random_uuid());
  select * into v_doc from public.ds_documents where id=v_id for update;
  if v_doc.id is not null and (v_doc.tenant_id<>p_tenant_id or (v_doc.created_by is distinct from auth.uid() and v_role not in ('owner','admin'))) then
    raise exception 'Document unavailable' using errcode='42501';
  end if;
  if p_action in ('reserve_job','reserve_template') then
    v_type:=case p_action when 'reserve_job' then 'job' else 'template' end;
    if v_doc.id is not null then
      if v_doc.created_by is distinct from auth.uid() or v_doc.record_type<>v_type then raise exception 'Document unavailable' using errcode='42501'; end if;
      if v_doc.status='ready' or (v_doc.status='processing' and v_doc.expires_at>now()) then return to_jsonb(v_doc); end if;
      if v_doc.status='deleting' then raise exception 'Deletion must finish first' using errcode='23514'; end if;
    else
      if (select count(*) from public.ds_documents where tenant_id=p_tenant_id and record_type=v_type)>=(case v_type when 'job' then 1000 else 100 end) then
        raise exception 'Organization record limit reached' using errcode='23514';
      end if;
    end if;
    if (select coalesce(sum(size_bytes),0) from public.ds_documents where tenant_id=p_tenant_id)-coalesce(v_doc.size_bytes,0)+16777216>268435456 then
      raise exception 'Organization storage limit reached' using errcode='23514';
    end if;
    if (select coalesce(sum(size_bytes),0) from public.ds_documents)-coalesce(v_doc.size_bytes,0)+16777216>v_limit then
      raise exception 'Free storage budget reached' using errcode='23514';
    end if;
    v_fields:=coalesce(p_data->'fields','[]'::jsonb);
    if jsonb_typeof(v_fields)<>'array' or jsonb_array_length(v_fields)>64 or exists(select 1 from jsonb_array_elements(v_fields) x where jsonb_typeof(x)<>'string') then
      raise exception 'Invalid template fields' using errcode='22023';
    end if;
    if v_type='template' and p_data->>'kind'<>'DOCX' then raise exception 'Invalid template type' using errcode='22023'; end if;
    insert into public.ds_documents(id,tenant_id,created_by,record_type,name,kind,source,created_at,status,size_bytes,fields)
    values(v_id,p_tenant_id,auth.uid(),v_type,p_data->>'name',p_data->>'kind',p_data->>'source',coalesce((p_data->>'created')::timestamptz,now()),'processing',16777216,v_fields)
    on conflict(id) do update set status='processing',error=null,size_bytes=16777216,expires_at=now()+interval '2 minutes'
    returning * into v_doc;
  elsif p_action='complete' then
    if v_doc.id is null or v_doc.created_by is distinct from auth.uid() or v_doc.status<>'processing' or v_doc.expires_at<=now() then raise exception 'Document reservation expired' using errcode='23514'; end if;
    select (metadata->>'size')::bigint into v_size from storage.objects where bucket_id='ds-documents' and name=v_doc.object_key;
    if v_size is null or v_size<1 or v_size>(case v_doc.record_type when 'template' then 4194304 else 16777216 end) or v_size<>(p_data->>'size')::bigint then
      raise exception 'Stored file size does not match' using errcode='23514';
    end if;
    if coalesce(p_data->>'sha256','') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid checksum' using errcode='22023'; end if;
    update public.ds_documents set status='ready',size_bytes=v_size,sha256=p_data->>'sha256',error=null where id=v_id returning * into v_doc;
  elsif p_action='fail' then
    if v_doc.id is null or v_doc.created_by is distinct from auth.uid() or v_doc.status<>'processing' then return null; end if;
    select (metadata->>'size')::bigint into v_size from storage.objects where bucket_id='ds-documents' and name=v_doc.object_key;
    update public.ds_documents set status='failed',size_bytes=coalesce(v_size,0),error=left(coalesce(p_data->>'error','Document processing failed.'),500) where id=v_id returning * into v_doc;
  elsif p_action='begin_delete' then
    if v_doc.id is null then return null; end if;
    if v_doc.status='processing' and v_doc.expires_at>now() then raise exception 'Wait for processing to finish' using errcode='23514'; end if;
    delete from public.ds_document_imports where id=v_id and tenant_id=p_tenant_id;
    update public.ds_documents set status='deleting' where id=v_id returning * into v_doc;
  elsif p_action='finish_delete' then
    if v_doc.id is null then return null; end if;
    if v_doc.status<>'deleting' or exists(select 1 from storage.objects where bucket_id='ds-documents' and name=v_doc.object_key) then raise exception 'File deletion is not complete' using errcode='23514'; end if;
    delete from public.ds_documents where id=v_id;
  else raise exception 'Invalid document operation' using errcode='22023'; end if;
  return to_jsonb(v_doc);
end $$;
create function public.ds_document_command(p_tenant_id uuid,p_action text,p_data jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select docuscripter_private.document_command(p_tenant_id,p_action,p_data) $$;
revoke all on function docuscripter_private.document_command(uuid,text,jsonb),public.ds_document_command(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function docuscripter_private.document_command(uuid,text,jsonb),public.ds_document_command(uuid,text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
