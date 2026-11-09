begin;
create or replace function docuscripter_private.document_command(p_tenant_id uuid,p_action text,p_data jsonb) returns jsonb
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
    update public.ds_documents set status='deleting' where id=v_id returning * into v_doc;
  elsif p_action='finish_delete' then
    if v_doc.id is null then return null; end if;
    if v_doc.status<>'deleting' or exists(select 1 from storage.objects where bucket_id='ds-documents' and name=v_doc.object_key) then raise exception 'File deletion is not complete' using errcode='23514'; end if;
    delete from public.ds_documents where id=v_id;
  else raise exception 'Invalid document operation' using errcode='22023'; end if;
  return to_jsonb(v_doc);
end $$;
drop table public.ds_document_imports;
notify pgrst,'reload schema';
commit;
