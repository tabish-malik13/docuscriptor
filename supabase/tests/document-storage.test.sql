begin;
create function pg_temp.assert(ok boolean,message text) returns void language plpgsql as $$begin if not coalesce(ok,false) then raise exception '%',message; end if; end$$;
insert into auth.users(id,email,email_confirmed_at) values('10000000-0000-4000-8000-000000000001','one@test.invalid',now()),('10000000-0000-4000-8000-000000000002','two@test.invalid',now()),('10000000-0000-4000-8000-000000000003','viewer@test.invalid',now());
insert into public.ds_tenants(id,name,slug) values('20000000-0000-4000-8000-000000000001','Isolated A','isolated-a'),('20000000-0000-4000-8000-000000000002','Isolated B','isolated-b');
insert into public.ds_memberships(tenant_id,user_id,email,role) values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','one@test.invalid','owner'),('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','two@test.invalid','owner'),('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','viewer@test.invalid','viewer');
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001"}',true);
set local role authenticated;
select public.ds_document_command('20000000-0000-4000-8000-000000000001','reserve_job','{"id":"30000000-0000-4000-8000-000000000001","name":"isolated.docx","kind":"DOCX","source":"Upload"}');
insert into storage.objects(bucket_id,name,metadata) values('ds-documents','20000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001','{"size":100}');
select public.ds_document_command('20000000-0000-4000-8000-000000000001','complete','{"id":"30000000-0000-4000-8000-000000000001","size":100,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}');
select pg_temp.assert((select size_bytes=100 and status='ready' from public.ds_documents),'Completion stores actual bytes');
do $$begin
 begin
  insert into public.ds_documents(id,tenant_id,record_type,name,kind,source,status,size_bytes) values(gen_random_uuid(),'20000000-0000-4000-8000-000000000001','job','bad','DOCX','bad','ready',0);
  raise exception 'Direct metadata writes allowed';
 exception when insufficient_privilege then null;end;
end$$;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000002"}',true);
select pg_temp.assert((select count(*)=0 from public.ds_documents),'Other tenant cannot read metadata');
select pg_temp.assert((select count(*)=0 from storage.objects),'Other tenant cannot download objects');
do $$begin
 begin
  perform public.ds_document_command('20000000-0000-4000-8000-000000000001','begin_delete','{"id":"30000000-0000-4000-8000-000000000001"}');
  raise exception 'Cross-tenant deletion allowed';
 exception when insufficient_privilege then null;end;
end$$;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000003"}',true);
select pg_temp.assert((select count(*)=1 from storage.objects),'Viewer reads shared ready objects');
do $$begin
 begin
  perform public.ds_document_command('20000000-0000-4000-8000-000000000001','reserve_job','{"name":"bad","kind":"DOCX","source":"bad"}');
  raise exception 'Viewer write allowed';
 exception when insufficient_privilege then null;end;
end$$;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001"}',true);
select public.ds_document_command('20000000-0000-4000-8000-000000000001','begin_delete','{"id":"30000000-0000-4000-8000-000000000001"}');
select pg_temp.assert((select count(*)=1 from storage.objects),'Deleting creator retains SELECT for Storage deletion');
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000003"}',true);
select pg_temp.assert((select count(*)=0 from storage.objects),'Viewer cannot read deleting file');
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001"}',true);
delete from storage.objects where bucket_id='ds-documents' and name='20000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001';
-- DELETE requires SELECT visibility in Storage/Postgres. Test this important interaction.
reset role;
select pg_temp.assert((select count(*)=0 from storage.objects),'Object deletion completed before metadata removal');
set local role authenticated;
select public.ds_document_command('20000000-0000-4000-8000-000000000001','finish_delete','{"id":"30000000-0000-4000-8000-000000000001"}');
select pg_temp.assert((select count(*)=0 from public.ds_documents),'Metadata deletion finishes after object removal');
reset role;
update docuscripter_private.document_budget set limit_bytes=100;
set local role authenticated;
do $$begin
 begin
  perform public.ds_document_command('20000000-0000-4000-8000-000000000001','reserve_job','{"name":"over-budget","kind":"DOCX","source":"Upload"}');
  raise exception 'Global free budget was exceeded';
 exception when check_violation then null;end;
end$$;
select pg_temp.assert((select count(*)=0 from public.ds_documents),'Failed reservation cannot create a partial record');
reset role;
rollback;
