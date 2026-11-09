# Cloud-only deployment on the free tiers

Live frontend: **https://docuscriptor.pages.dev**. Organizations use `/org/<slug>`.

| Component | Host |
| --- | --- |
| React workspace and browser DOCX editor | Cloudflare Pages |
| Verified API gateway for organizations and files | Pages Worker |
| Identity and organization memberships | Supabase Auth and Postgres |
| Document metadata | Supabase Postgres `ds_documents`, with RLS |
| Private DOCX/PDF files | Supabase Storage `ds-documents` bucket |

No PC backend, tunnel, SQLite database, persistent server disk, or purchased domain is required. Existing local documents are not imported, as requested. The old SQLite adapter is used only by historical regression tests; production imports never load it.

## Supported in this version

Verified sign-in, organization creation, invitations, roles, private document upload/download/deletion, and the browser DOCX editor are available. Uploads accept DOCX/PDF files up to 4 MB. Download edits from the browser editor, then upload the result to the organization's Documents page. Uploads are stored as supplied; this release does not run server document inspection, conversion, or malware scanning.

DOCX generation, template processing, and PDF conversion are disabled in the hosted UI and API. Their source and separately deployable services remain in the repository for future use. A caller cannot enable hosted processing by changing the client flag: the hosted gateway has no processing-service calls and returns 501 after authorization.

## Free limits

Supabase currently includes 1 GB file storage and a 500 MB Postgres database on its Free plan. The application's Storage reservations are capped at **768 MiB across all organizations**, with **256 MiB per organization**, leaving headroom below the file allowance. Every pending upload reserves 16 MiB; completion releases the unused reservation. Metadata and free request/egress allowances still need monitoring. No paid plan is enabled by this deployment.

Objects use immutable organization/UUID paths. RLS checks current verified membership for reads; only owners/admins/operators can write, and operators can delete only their own files. Viewer downloads are allowed. Uploaded file checksums are verified before downloads. A two-step deletion removes Storage bytes before metadata; interrupted deletions can be retried. Expired uploads appear as failed records and can be deleted to reclaim quota. Only administrators may change the internal project budget.

## Deploy

1. Apply the migrations in `supabase/migrations` in order, or install `supabase/tenant-access.sql` then `supabase/document-storage.sql` on a fresh Supabase instance. Use the canonical SQL files only for fresh installs, not over an existing schema. No users or organizations are seeded.
2. Configure the root `.env` locally, or the Cloudflare project build variables:

   ```text
   PUBLIC_APP_ORIGIN=https://docuscriptor.pages.dev
   VITE_SUPABASE_URL=https://<project>.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   ```

   The publishable key is intentionally public. No Supabase secret/service-role key or processing-service secret belongs in Pages. The Pages build forces path routing and disables processing. `wrangler.jsonc` enables Node compatibility for the gateway's Buffer/crypto primitives; no Node server runs in Pages.
3. Build and publish:

   ```sh
   npm ci
   PUBLIC_APP_ORIGIN=https://docuscriptor.pages.dev npm run build:pages
   npx --yes wrangler@4.158.0 login
   npx --yes wrangler@4.158.0 pages deploy frontend/dist --project-name docuscriptor --branch main
   ```

4. For Git-connected builds, use repository root, build command `npm run build:pages`, output directory `frontend/dist`, and Node 24+. Push the new source/configuration files before relying on automatic Git builds.
5. Set Supabase Auth's Site URL and confirmation redirect allowlist to the actual Pages origin. Public registration requires email verification.

`BACKEND_ORIGIN` is no longer used. Shut down the old quick tunnel and preview containers after publishing. The frontend and API should keep working with Docker stopped.

## Verification

`npm run check` tests identity, membership, serverless routes, cloud persistence requests, processing-service regressions, and the production frontend build. CI separately tests RLS, quota reservations, private object access and deletion ordering in disposable PostgreSQL, and builds the Pages Worker. Test identities exist only in isolated fixtures and SQL transactions that roll back.

References: [Supabase pricing](https://supabase.com/pricing), [Storage access control](https://supabase.com/docs/guides/storage/security/access-control), [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/).

## Render processing pilot and scheduled health requests

The optional `render.yaml` deploys one **Free** Docker web service using `infra/Render.Containerfile`. It exposes only the verified gateway. DOCX, PDF adapter and Gotenberg listeners bind to private loopback addresses. They share one Node runtime in this small-instance profile but remain independently deployable from their normal entry points. Gotenberg's Basic Auth and service HMAC keys are generated at startup and never stored in Pages or Git. Documents remain in Supabase.

The free profile allows one active processing request, starts Chromium/LibreOffice on demand, and shuts idle renderer engines down after ten seconds. The image was exercised with a 512 MiB RAM / 0.5 CPU container: isolated HTML and DOCX conversions passed, with a measured peak of approximately 329 MiB. This is a small-file pilot, not a guarantee for every document. Render may restart or suspend free instances, and the free hour/build/egress quotas still apply.

Configure the Render gateway with `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `APP_ORIGIN=https://docuscriptor.pages.dev`, `ORGANIZATION_BASE_DOMAIN=docuscriptor.pages.dev` and `ORGANIZATION_ROUTING=path`. No database password, Supabase service-role key, persistent disk or paid service is required. `GET /api/health` checks the private renderer without processing a document.

After the Render service is healthy:

1. Set `PROCESSOR_ORIGIN=https://<actual-service>.onrender.com` as a **Pages runtime variable**.
2. Rebuild with `PUBLIC_PROCESSOR_ENABLED=true PUBLIC_APP_ORIGIN=https://docuscriptor.pages.dev npm run build:pages`, then publish Pages. The client retains uploads as well as generation/conversion. Both gateways verify identity, organization scope and role; the renderer remains private.
3. Deploy the free scheduled health Worker with `PROCESSOR_ORIGIN=https://<actual-service>.onrender.com npm run deploy:processing-health`.

The scheduled Worker sends only an unauthenticated GET to the public gateway health endpoint. It sends no user credentials, documents or conversion requests. Cron `*/14 * * * *` runs at UTC minutes 0, 14, 28, 42 and 56 (the hour boundary creates a four-minute gap). This targets gaps of at most fourteen minutes; actual scheduler delays can still let Render sleep. Render's own readiness probes do not replace this inbound request. Keeping a service active consumes its included free instance hours.

The processing proxy polls readiness for up to 90 seconds to tolerate cold starts. It then submits the actual processing POST **once**, without retrying a possibly completed operation. Client requests allow 150 seconds and explain the initial wake-up delay. Redirects are rejected, and credentials are forwarded only to the configured processing origin.
