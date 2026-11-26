# Supabase setup

The application supports hosted or separately self-hosted Supabase. The selected hosted project is [DocuScripter](https://supabase.com/dashboard/project/ttyrtwackxzyhtbvuhmf) in Mumbai (`ap-south-1`), project reference `ttyrtwackxzyhtbvuhmf`. The local ignored `.env` contains its public URL and publishable key; no service-role/secret key is required by the app.

## Installed organization authority

The hosted project has migration `20261108184608_organization_workspaces` applied. Its reviewed source is in [the original migration](migrations/20261108184608_organization_workspaces.sql). Do not run the initial schema again on that project. Deployments that already use it can apply [the pending invitation name migration](migrations/20261126000000_refresh_invitation_names.sql) to show the current organization name to invitees after a rename. It also updates pending invitations that already carry an old name. Fresh installations can use the complete schema below.

## Install on another project

1. Open the project's [SQL editor](https://supabase.com/dashboard/project/ttyrtwackxzyhtbvuhmf/sql/new).
2. Run the complete contents of [`tenant-access.sql`](tenant-access.sql) **once** as an administrator. It creates the tenant tables, indexes, RLS policies and RPCs without inserting accounts, tenants, memberships, invitations, or documents. For managed deployments, apply it as a tracked migration with your normal Supabase migration workflow.
3. Keep `docuscripter_private` out of the project's exposed Data API schemas. Leave `public` exposed. Table grants are explicit in the migration, including on projects where new tables are not automatically exposed.
4. Run [`verify.sql`](verify.sql) and the Supabase security/performance advisors. Verify all four public tenant tables have RLS enabled, anonymous roles have no access, and exposed RPCs are security invokers.

If the schema is not installed, the gateway returns a clear `503` and never falls back to global roles or personal authorization. The SQL file is the initial schema for a fresh project; do not rerun it against an already migrated project.

## Configure authentication

In [Auth URL configuration](https://supabase.com/dashboard/project/ttyrtwackxzyhtbvuhmf/auth/url-configuration), set the Site URL to your real application origin. For local Compose, use `http://localhost:4173`. Add the local Vite origin (`http://127.0.0.1:5173`) if using it for development. Set production HTTPS origins before deployment.

Enable email/password authentication and email confirmation in the [email provider settings](https://supabase.com/dashboard/project/ttyrtwackxzyhtbvuhmf/auth/providers). Disable anonymous sign-ins. The app offers account registration followed by email verification, then sign-in. If your deployment is invitation-only, disable new sign-ups in Supabase and provision real accounts through its administrator interface instead. No account is provisioned or fabricated by the setup code.

The first real user signs up, verifies their own email, signs in and creates a named organization with a unique workspace address in the app. That operation atomically creates the tenant and its first owner. There is no seeded tenant, global administrator, metadata-based role assignment or automatic personal-data sharing.

Organization administrators create invitations in **Organization settings**. Invitations are addressed to an email, expire after seven days, and require that exact verified email to accept. The app does not send invitation messages; ask the recipient to sign in or register using that email and accept the pending invitation. Registration confirmation messages are handled by Supabase Auth.

## Access model

- Owners manage ownership as well as membership and tenant content. Tenants must retain at least one owner; this is checked under a row lock and protected by a trigger even when Auth attempts to delete the last owner's account.
- Admins manage non-owner memberships, invitations, tenant name and tenant content. They cannot appoint themselves as owners or change another owner's role.
- Operators generate/convert documents and manage content they created. All members can download shared tenant content.
- Viewers only read and download tenant content. Members may leave their tenant, subject to the last-owner rule.

Supabase RLS protects the tenant directory, memberships, invitation recipients and administrator audit. The gateway uses the signed-in user's bearer token and publishable key for these operations. It checks membership for each human document request and again before persisting a processing result.

Owners and admins can issue API clients for their workspace. The gateway stores these organization-owned grants in its SQLite volume and validates token expiry, revocation, tenant and operation scope for each machine request. It checks the token again before saving a processing result. Removing the administrator who issued a client preserves that client's grant. Revoke the workspace's clients before decommissioning a tenant directly in Supabase. Restoring an older gateway backup can also restore earlier grants, so rotate or revoke affected credentials before reopening traffic.

Documents and template bytes stay in the gateway's local SQLite volume, with `tenant_id` filters on every operation and per-tenant quotas. They are accessed exclusively through the gateway, not the Supabase Data API. DOCX and PDF service assertions also include the verified tenant ID. One gateway process per SQLite database remains the deployment model.

## Existing personal data

The gateway upgrades its SQLite database to version 4 on startup. Version 4 adds batches, queued rows and terminal input cleanup. These tables use the existing tenant and caller identities and need no new Supabase SQL. Version 3 added the API client, access-token and credential audit tables. Each creation, secret rotation and revocation records the tenant, client, acting administrator and time in the same transaction. Organization settings shows the latest 50 changes across this history and the Supabase tenant audit. The version 2 migration assigns previously personal records to no tenant and retains their creator IDs. A tenant owner can explicitly import **their own** old records in Tenant administration. The app explains that importing shares those files with every tenant member and requires confirmation. Back up the SQLite volume before upgrading.

## Database tests

`tests/bootstrap.sql` creates a minimal Auth contract and test roles for an **empty, disposable PostgreSQL database only**. Never run that bootstrap in your hosted project. GitHub Actions starts its preinstalled PostgreSQL 16 service and pipes bootstrap, schema, and `tests/tenant-access.test.sql` into a fresh database. The tests exercise actual RLS and RPC permissions, invitations, tenant isolation, ownership changes, role escalation attempts and last-owner protection. Fixtures and SQL test helpers are rolled back.

The regular Node tests use isolated identity/tenant doubles and temporary SQLite files. They cover the real gateway and processing services, including tenant sharing, member removal during processing, independent roles in multiple tenants, content deletion permissions, and safe legacy migration.

## Production domain

The selected base domain is `docuscriptor.com`. Configure wildcard DNS, HTTPS ingress, and the public origin/domain build settings as described in the root README before using public workspace URLs. Local development uses `docuscriptor.localhost` workspace subdomains and needs no public DNS changes.

The hosted security advisor reports that [leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) is disabled. This is a provider setting; no paid feature is required by DocuScripter.
