-- ONLY for an empty disposable PostgreSQL test database, never a Supabase project.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
grant usage on schema auth,public to authenticated,anon;
create table auth.users (
  id uuid primary key,
  email text not null,
  email_confirmed_at timestamptz,
  is_anonymous boolean default false
);
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims',true),'')::jsonb ->> 'sub')::uuid
$$;
