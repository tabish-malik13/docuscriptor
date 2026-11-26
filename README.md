# DocuScripter

A proprietary document workspace built with self-hostable open-source components: Supabase Auth, a browser DOCX editor, private DOCX generation and PDF conversion services, and SQLite storage. See [project rules](AGENTS.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Local editor

Use Node.js 24 or later:

```sh
npm ci
npm run dev:web
```

The [DOCX editor](http://127.0.0.1:5173/editor.html) opens on a blank page. Anyone can write, open a DOCX up to 4 MB and download a Word file locally. Sign in to see your saved templates under **My templates**. Choose **Save template** to add a new document to the organization’s library. When editing a saved template, choose **Save version** to keep its name and ID, or **Save a copy** to create a separate template. Click the version number to see earlier versions and download them. Download or save your edits before leaving.

## Run the full workspace

1. Preserve an existing configured `.env`; otherwise copy `.env.example` to `.env`.
2. Configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` using your separately deployed [self-hosted Supabase](https://supabase.com/docs/guides/self-hosting/docker) instance. Hosted Supabase is optional. Use a project origin and an `sb_publishable_…` key; never put secret or service-role keys in browser variables. For self-hosted projects, [enable publishable API keys](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys).
3. Generate three **different** server secrets by running `openssl rand -hex 32` three times. Put the results in `DOCX_SERVICE_SECRET`, `PDF_SERVICE_SECRET`, and `GOTENBERG_PASSWORD`. Each must contain at least 32 bytes. There are no default credentials.
4. Install [the Supabase tenant schema and authentication settings](supabase/README.md). Tenant roles live in database memberships protected by RLS; global `app_metadata.workspace_role` values no longer grant access. Public registration requires email verification. For an invitation-only deployment, disable sign-ups in Supabase and provision real users through its administrator interface.
5. Start Docker and run:

```sh
docker compose up --build -d
```

Open [the workspace](http://localhost:4173/), sign in with a verified account, then create a tenant or accept an invitation. Only the web entry point is published, on the loopback interface. For access from other machines, configure your HTTPS ingress and the web port binding.

For Supabase on the same Docker host, optionally set `SUPABASE_GATEWAY_URL` to a container-reachable origin, such as `http://host.docker.internal:54321` on Docker Desktop, while keeping `VITE_SUPABASE_URL` browser-reachable. No demo records, users, or documents are seeded.

For native development, run `npm run dev` after configuring `.env`. It starts the gateway, DOCX service, PDF adapter, and Vite together, and reuses any of these services already running. If Docker is available, it starts an authenticated loopback-only PDF renderer in the separate `docuscripter-native` Compose project. Without Docker, sign-in, organization management, the local editor, and Word generation still work; PDF conversion needs the renderer. Use `npm run dev:web` only when deliberately running the API separately.

For frontend development against the running Compose stack, set `DEV_GATEWAY_URL=http://127.0.0.1:4173` in `.env`, then run `npm run dev`. Without that override, Vite proxies to a native gateway on port 4000. Native service commands are `npm run start:gateway`, `npm run start:docx`, and `npm run start:pdf`; all load the root `.env`. A native PDF adapter also needs `GOTENBERG_URL` and an authenticated Gotenberg renderer.

## Deployment feature flags

Set these flags to `true` or `false` in the gateway environment or root `.env`. Omitted flags default to `true` to preserve existing installations. Stripe and Razorpay each require a separate opt-in and merchant credentials. Restart the native gateway or run `docker compose up -d --no-deps --force-recreate gateway`, then reload the browser. The gateway enforces the settings and publishes the effective switches at `GET /api/features`.

| Setting | What it controls |
| --- | --- |
| `FEATURE_AUTH` | Human workspace sign-in. Set to `false` to open the local DOCX editor directly without sign-in or access to saved organization files. Existing scoped machine credentials can still use enabled APIs. |
| `FEATURE_API_CLIENTS` | API client provisioning, token exchange and use of issued client tokens. WhatsApp and template edits through API clients depend on this flag. |
| `FEATURE_WHATSAPP` | Organization WhatsApp settings, inbound webhooks and message processing. Requires API clients. |
| `FEATURE_BILLING` | Billing page, checkout, status refresh and payment webhooks. Active contract limits and previously confirmed paid terms still apply. |
| `FEATURE_BATCHES` | Bulk generation, batch processing and archive downloads. |
| `FEATURE_TEMPLATE_VERSIONS` | Saving revisions and accessing template version history. Existing records and pinned batch inputs are retained. |
| `FEATURE_TEMPLATE_API_EDITS` | Allows API clients to edit existing templates through PATCH or version upload. Requires API clients and versioning. Clients with write permission can still create templates when this is off. |
| `FEATURE_TEMPLATE_DELETION` | Deleting saved templates from the editor, organization library or API. |
| `FEATURE_LIVE_PREVIEW` | The live Word preview beside generation fields and the gateway preview endpoint. |
| `FEATURE_ORG_CREATION` | Self-service organization creation in DocuScripter. Existing verified memberships continue to work. |
| `FEATURE_RATE_LIMITS` | Per-user, per-client and per-organization traffic and write budgets. Public ingress, token exchange, webhook and route-specific limits still apply. |

Keep `FEATURE_AUTH=true` for signed-in workspaces. For a browser-only deployment, set `FEATURE_AUTH=false` and `FEATURE_API_CLIENTS=false`. The local editor opens, edits and downloads files on the device. To enable sign-in on a build created without identity settings, configure the Supabase public settings in the frontend build and gateway first. These flags control DocuScripter. Supabase sign-up policy and direct database access are administered in Supabase.

## Free hosted preview

For a free `pages.dev` frontend with `/org/<slug>` workspaces and a temporary backend running on your computer, follow [the deployment guide](docs/deployment.md). The frontend API proxy needs a live backend tunnel; it does not run the DOCX/PDF engines itself. No domain ownership is required.

## Organization workspace addresses

The account page lists **Your organizations**. Create an organization with its name and a unique workspace address, then open its workspace. The internal tenant model is not exposed as a user-facing control. Workspace settings manage members, roles and invitations.

Native development uses `http://<organization>.docuscriptor.localhost:5173/`, with central sign-in at `http://127.0.0.1:5173/`. The `.localhost` suffix resolves to loopback in supported browsers. Production is configured for `https://<organization>.docuscriptor.com/` by setting `PUBLIC_APP_ORIGIN=https://docuscriptor.com` and `PUBLIC_ORGANIZATION_BASE_DOMAIN=docuscriptor.com` before building the Compose images. The organization address is stable when its display name changes. Subdomain requests are checked against both membership and the organization selected by their host.

The central account page transfers sign-in using a single-use, 60-second ticket protected by a browser-held proof verifier. Access and refresh tokens are never placed in URLs. Different workspace origins keep separate browser authentication state. Signing out from the directory or an organization ends that Supabase session across the gateway and returns the browser to the account page. Open workspaces and the editor recheck access on focus, navigation restoration and while visible. Independent sign-ins on other devices keep their own sessions. The gateway stores a digest of the ended session in the workspace database so renewed tokens and outstanding handoff tickets for that session cannot reopen it. A gateway restart invalidates pending tickets. Returning to the directory starts a new handoff.

To make public addresses live, point `docuscriptor.com` and `*.docuscriptor.com` to your application ingress and terminate HTTPS with certificates covering both. Forward the original `Host` header and `/api/*` to the same app deployment. The supplied Caddy container serves port 4173 behind that ingress; it does not provision external DNS or wildcard certificates. Set Supabase Auth's Site URL and allowed confirmation redirects to the central production origin. No DNS provider or production host is configured by this repository.

## API clients and WhatsApp

In **Organization settings → API clients**, owners and admins can issue, rotate, and revoke a consumer key (client ID) and secret for a server integration. Each client belongs to one organization and can receive just the permissions it needs. For example, a converter can return its own PDFs using only `documents:convert`. [Client setup, scopes and runnable conversion example](docs/client-api.md)

In **Organization settings → WhatsApp**, owners and admins can connect a WhatsApp Business number, select a workspace API client, enroll permitted senders and copy their organization’s webhook URL into Meta. They can edit or disconnect the connection at any time. The optional adapter accepts signed messages from enrolled senders and calls the same tenant-scoped gateway. A sender can attach a Word file and receive a PDF, generate a document from a template, or work with saved documents according to the configured client's permissions. It requires a WhatsApp Business account, Meta credentials and a reachable HTTPS callback. The visual DOCX editor and organization administration use the browser. The core workspace and client API run independently of WhatsApp. [WhatsApp setup and chat commands](docs/whatsapp.md)

## Organization billing

Organization owners can open **Billing & plans** to see their license, allowances and usage. Enable managed billing to offer Plus and Ultimate through Stripe or Razorpay, or assign contract licenses by organization UUID. Both payment integrations are disabled by default. [Billing configuration and activation guide](docs/billing.md)

## Document workflows

Overview provides direct access to document tools, template previews and recent activity. Pin a template from the library to keep it on your personal overview in this browser and organization. [Workspace screenshots and design research](docs/workspace-design.md)

- **Bulk generation** turns a UTF-8 CSV roster into up to 100 individually named PDFs or Word files. Choose the certificate-of-completion starter or a saved Word template, match columns, review the first finished file, and download a ZIP. Runs can be paused and reopened. [Operator and API guide](docs/bulk-generation.md) · [Market research and pilot proposal](docs/product-strategy.md)
- **Generate DOCX** shows a read-only Word preview alongside the runtime values for a starter, saved template or uploaded DOCX. Type a value to see it in place. Unfilled fields appear as tokens such as `{customer_name}`. Choose **Generate DOCX** to download the finished document and save it in Activity. Each required field needs a value. Loops, executable expressions, macros, and embedded objects are rejected.
- **Convert PDF:** upload a DOCX or self-contained UTF-8 HTML file. Images and CSS must be embedded. Scripts, macros, and outbound renderer requests are disabled.
- **Templates** lets you upload and reuse Word templates. Their fields appear automatically as form inputs. In the DOCX editor, **My templates** lists your own uploads and their current versions. To remove a saved template and its version history, choose its trash icon in **My templates** or **Organization templates** and confirm deletion. Operators can delete their own uploads. Owners and admins can delete any saved template in their organization.
- **Activity:** view processing, ready, and failed jobs; download saved outputs; delete old jobs and their outputs; load older history. The page refreshes while a displayed job is processing. Reloading the browser preserves server-saved history and documents.

Document API processing is synchronous. The gateway supports four concurrent operations overall and two per organization by default, with a 4 MB input limit and a 16 MB output limit. Set `TENANT_PROCESSING_CONCURRENCY` to an integer from 1 to 4 to change the per-organization cap. The default self-hosted and Starter licenses include 256 MiB of storage (including reserved space for in-flight outputs), up to 1,000 retained jobs and 100 saved templates. Plus and Ultimate have configurable organization allowances. Delete saved records to free the tenant quota. History is paginated in batches of 50. Failed jobs retain a safe error message. Uploaded files are retained only when explicitly saved as templates. Single-document requests discard runtime values after processing. Bulk generation stores queued values until their row finishes or fails, the creator discards the batch, or its 30-day retention period expires. Outputs contain the values rendered into them.

## Services and authorization

| Component | Purpose |
| --- | --- |
| `frontend` | React/Vite static workspace and separate local editor entry point |
| Supabase | Separately deployed Auth and Postgres tenant authority protected by RLS |
| `backend/gateway` | Verifies human sessions and organization roles, issues scoped machine tokens, enforces quotas and stores tenant documents |
| `backend/docx` | Private DOCX generation and template inspection service |
| `backend/pdf` | Private PDF adapter that validates uploads and authenticates to Gotenberg |
| Gotenberg renderer | Private LibreOffice/Chromium engine, reachable only from the PDF adapter network |

Browser document requests go through `/api/*` and include `X-Tenant-Id`. That header selects a scope; it never grants access. The gateway verifies the bearer token with Supabase Auth and queries current membership with that user's token. Documents, templates and quotas belong to the tenant. Members can access shared content, while people outside the tenant cannot access it even if they own another tenant. A user's roles in different tenants are independent. Viewers cannot mutate content; operators delete content they created; owners and admins manage tenant content.

Tenant switching remounts the workspace and clears loaded data and processing forms. The UI refreshes membership on window focus and periodically. The gateway checks current membership on tenant-scoped human requests. Processing permission is rechecked before an output or template is saved or returned, so removing a member during generation discards their pending result.

After verifying the caller’s processing permission, the gateway sends a service-specific HMAC assertion with the user or API client identity, tenant ID, expiry, nonce, method, route, and payload hash. Processing services reject unsigned requests, tampering, expired assertions, wrong audiences and replay. Keys remain server-only. The renderer additionally requires Basic authentication. Private processing networks and renderer egress restrictions remain enforced by Compose. For services on separate hosts, use private TLS connections and manage the three secrets in your deployment secret store.

Tenant owners and admins manage invitations and roles in **Organization settings**. Invitations require the recipient's exact verified email and expire after seven days; no invitation email is sent by the app. Owners may appoint additional owners, and the last owner cannot leave, be demoted, or have their Auth account deleted without transferring ownership first. Access changes are audited. New accounts do not receive fabricated identities, seeded tenants, or automatic access to other organizations.

The gateway applies configurable limits to incoming traffic, token exchanges, WhatsApp webhooks, verified users and API clients, and tenant-wide traffic and writes. By default, callers behind the same proxy share its source-IP budget. Configure trusted proxy addresses to match your ingress. [Rate limits, defaults and proxy configuration](docs/rate-limits.md)

## Storage and operations

Compose persists `/app/data/workspace.sqlite` in the `workspace-data` named volume. Back up before upgrading from the personal workspace version: legacy files remain quarantined until their creator explicitly imports them into a tenant they own. Native gateway runs default to `.data/workspace.sqlite`; `DATA_PATH` overrides the filename. The database includes artifact BLOBs, templates and metadata with tenant-filtered queries, transactions and SQLite WAL. Database files are created with restricted permissions. Supabase holds the tenant directory, memberships, invitations and access audit; apply the SQL schema before use. Document bytes are stored on the gateway volume. When WhatsApp is enabled, requested inputs and outputs also pass through Meta. The gateway needs no Supabase Storage bucket or service-role key.

Run **one gateway process per database** on local disk. Startup marks interrupted processing jobs failed so users can resubmit; it does not silently replay document operations. For multiple gateway replicas, move this store behind a database/storage service first. The gateway encrypts WhatsApp connection credentials at the application layer. Use encrypted host storage where required for the document database, messaging inbox and backups. Deleted records stop being accessible through the API; historical bytes may remain in SQLite pages or backups until those are reclaimed under your retention policy.

Back up the complete named volume while the gateway is stopped (`docker compose stop gateway`), then restart it (`docker compose start gateway`). Restore the database/volume with the gateway stopped as well. Do not copy only the main SQLite file from a running WAL database. `docker compose down` preserves the volume; `docker compose down -v` permanently deletes saved workspace data. Database pages are reused after deletion; a maintenance SQLite `VACUUM` can reclaim unused disk space while the gateway is stopped.

The Caddy image serves `frontend/dist` and proxies the gateway. The editor has a separate Content Security Policy for its WebAssembly worker. If serving the frontend elsewhere, preserve both policies and proxy `/api/*`; allow the Supabase project origin in the workspace `connect-src` policy.

## API

The endpoints below require a verified bearer token. Human document requests use `X-Tenant-Id` and current membership. Human processing and template writes require an operator, admin, or owner. Server integrations use a tenant-bound token with the matching document permissions. IDs are opaque UUIDs and tenant scope is checked on every access.

| Method | Endpoint | Result |
| --- | --- | --- |
| POST | `/api/docx/generate` | DOCX attachment; supply `{templateId, values}`, `{savedTemplateId, values}`, or `{filename, file, values}` |
| POST | `/api/docx/preview` | Transient DOCX with missing values shown as tokens. Explicit empty strings render as blank. Accepts the generation inputs. Supply `savedTemplateVersion` with `savedTemplateId` to use the same revision for preview and generation. |
| POST | `/api/pdf/convert` | PDF attachment; supply `{filename, file}` |
| POST / GET | `/api/batches` | Create a run with mapped rows or list the caller’s runs in this tenant |
| GET / DELETE | `/api/batches/:id` | Inspect row outcomes or discard the run and queued inputs |
| POST | `/api/batches/:id/next` | Process one pending row with current authorization |
| GET | `/api/batches/:id/download` | ZIP of available files with included and omitted counts |
| GET | `/api/jobs?offset=0` | `{items, nextOffset}` with durable job status |
| GET | `/api/jobs/:id` | Job metadata |
| GET | `/api/jobs/:id/download` | Saved ready artifact |
| DELETE | `/api/jobs/:id` | Delete a completed/failed job and its artifact |
| GET | `/api/templates` | Selected tenant’s template metadata |
| POST | `/api/templates` | Save `{name, filename, file}` after DOCX inspection |
| GET | `/api/templates/:id` | Current template metadata, including name, fields and version |
| PATCH | `/api/templates/:id` | Edit the reviewed `baseVersion`. Supply `name`, the pair `filename` and `file`, or both changes together. Returns updated metadata or HTTP 409 for a version conflict. |
| GET / POST | `/api/templates/:id/versions` | List versions or append one with `{baseVersion, filename, file}`. A concurrent edit returns 409. |
| GET | `/api/templates/:id/versions/:version/download` | Download the exact DOCX for a version. Template downloads include `X-Template-Version`. |
| GET | `/api/templates/:id/download` | Current saved DOCX template |
| DELETE | `/api/templates/:id` | Delete a saved template (creator or tenant admin/owner) |
| GET / POST | `/api/organizations` | List memberships or create `{name, slug}` organization |
| GET | `/api/invitations` | Your pending invitations |
| POST | `/api/invitations/:id/accept` | Accept an invitation addressed to your verified email |
| PATCH | `/api/tenant` | Rename selected tenant (admin/owner) |
| GET | `/api/tenant/members` | List members (admin/owner) |
| PATCH / DELETE | `/api/tenant/members/:id` | Change role or remove a member, with ownership protection |
| POST | `/api/tenant/leave` | Leave selected tenant |
| GET / POST | `/api/tenant/invitations` | List or create invitations (admin/owner) |
| DELETE | `/api/tenant/invitations/:id` | Revoke invitation (admin/owner) |
| GET | `/api/tenant/audit` | Latest 50 access changes (admin/owner) |
| GET | `/api/personal-records` | Counts of your quarantined legacy records |
| POST | `/api/tenant/import-personal` | Import your legacy files into a tenant you own; requires `{shareWithTenant: true}` |

For a server-side example that authenticates an API client and edits a template saved in the UI, see [Edit a saved template](docs/client-api.md#edit-a-saved-template).

`file` is canonical base64. Successful processing responses include `X-Document-Id` for the persisted job. `/api/health` and private service `/health` routes are unauthenticated probes and do not process documents. PDF readiness includes checking the renderer.

## Checks

```sh
npm run check
```

This runs Node's built-in test runner and the TypeScript/Vite production build. Tests use temporary databases and isolated in-memory identity/tenant/renderer doubles; they never provision users or seed workspace data. They cover real DOCX rendering, persistence/restart recovery, template workflows, tenant isolation and sharing, role revocation during processing, safe personal-data migration, auth failures, signed service requests, upload validation, pagination, quotas and renderer failures.

The GitHub Actions workflow also tests tenant RLS and ownership/invitation RPCs against a disposable PostgreSQL database, then starts the pinned Gotenberg image and tests real HTML and DOCX conversion plus renderer authentication. To run that test locally against an isolated authenticated renderer, set `GOTENBERG_TEST_URL` and `GOTENBERG_TEST_PASSWORD` when running `npm test`. Without them, that one integration test is explicitly skipped. The check command can also run on a self-hosted CI runner; no CI service is required by the application.

The integration suite covers OAuth grants, narrow scopes, key rotation and revocation, tenant limits, signed WhatsApp callbacks, duplicate deliveries, and the public proxy. WhatsApp tests simulate Meta’s media and messaging endpoints. Batch tests check CSV mapping, certificate fields, naming, idempotency, quota accounting, recovery, partial downloads and tenant isolation. The opt-in live renderer check also generates a two-certificate PDF batch.

## Dependency notices

The frontend build produces `/third-party-notices.txt` with bundled dependency and font notices. Runtime npm packages retain their own license files. No paid editor modules or commercial Docxtemplater add-ons are used. Storage uses Node's built-in SQLite module rather than an additional package. See [third-party inventory and sources](THIRD_PARTY_NOTICES.md) before redistributing container images.
