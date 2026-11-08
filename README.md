# DocuScripter

A proprietary document workspace built with self-hostable open-source components: Supabase Auth, a browser DOCX editor, private DOCX generation and PDF conversion services, and SQLite storage. See [project rules](AGENTS.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Local editor

Use Node.js 24 or later:

```sh
npm ci
npm run dev
```

Open [the DOCX editor](http://127.0.0.1:5173/editor.html) to create a blank Word document, open a DOCX up to 4 MB, edit it, and download the result. The local editor needs no account and keeps its document in browser memory. Download edits before leaving; it does not save to the server.

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

For frontend development against the running Compose stack, set `DEV_GATEWAY_URL=http://127.0.0.1:4173` in `.env`, then run `npm run dev`. Without that override, Vite proxies to a native gateway on port 4000. Native service commands are `npm run start:gateway`, `npm run start:docx`, and `npm run start:pdf`; all load the root `.env`. A native PDF adapter also needs `GOTENBERG_URL` and an authenticated Gotenberg renderer.

## Document workflows

- **Generate DOCX:** choose an invoice, business letter, or project brief starter, upload a Word template with JSON values, or choose a saved custom template. Supported placeholders are simple text fields such as `{customer_name}`. Each required field needs a value. Loops, executable expressions, macros, and embedded objects are rejected.
- **Convert PDF:** upload a DOCX or self-contained UTF-8 HTML file. Images and CSS must be embedded. Scripts, macros, and outbound renderer requests are disabled.
- **Templates:** upload, inspect, download, reuse, and delete tenant custom Word templates. Fields are discovered automatically and shown as form inputs. Download a template into the local editor to revise it, then upload the revised version.
- **Activity:** view processing, ready, and failed jobs; download saved outputs; delete old jobs and their outputs; load older history. The page refreshes while a displayed job is processing. Reloading the browser preserves server-saved history and documents.

Processing is synchronous, with four concurrent gateway operations, a 4 MB input limit and a 16 MB output limit. Each tenant has a 256 MB storage budget (including reserved space for in-flight outputs), up to 1,000 jobs and 100 saved templates. Delete saved records to free the tenant quota. History is paginated in batches of 50. Failed jobs retain a safe error message; uploaded source files and runtime values are not saved, except DOCX files explicitly saved as templates. Outputs naturally contain the values rendered into them.

## Services and authorization

| Component | Purpose |
| --- | --- |
| `frontend` | React/Vite static workspace and separate local editor entry point |
| Supabase | Separately deployed Auth and Postgres tenant authority protected by RLS |
| `backend/gateway` | Verifies Supabase identity and current tenant membership, enforces tenant roles, persists tenant jobs, templates and outputs |
| `backend/docx` | Private DOCX generation and template inspection service |
| `backend/pdf` | Private PDF adapter that validates uploads and authenticates to Gotenberg |
| Gotenberg renderer | Private LibreOffice/Chromium engine, reachable only from the PDF adapter network |

All workspace document requests go through `/api/*` and include `X-Tenant-Id`. That header selects a scope; it never grants access. The gateway verifies the bearer token with Supabase Auth and queries current membership with that user's token. Documents, templates and quotas belong to the tenant. Members can access shared content, while people outside the tenant cannot access it even if they own another tenant. A user's roles in different tenants are independent. Viewers cannot mutate content; operators delete content they created; owners and admins manage tenant content.

Tenant switching remounts the workspace and clears loaded data and processing forms. Membership is refreshed on window focus and periodically, and rechecked on every backend request. Processing permission is rechecked before an output or template is saved or returned, so removing a member during generation discards their pending result.

After verifying a user's tenant processing permission, the gateway sends a service-specific HMAC assertion with the user ID, tenant ID, expiry, nonce, method, route, and payload hash. Processing services reject unsigned requests, tampering, expired assertions, wrong audiences and replay. Keys remain server-only. The renderer additionally requires Basic authentication. Private processing networks and renderer egress restrictions remain enforced by Compose. For services on separate hosts, use private TLS connections and manage the three secrets in your deployment secret store.

Tenant owners and admins manage invitations and roles in **Tenant administration**. Invitations require the recipient's exact verified email and expire after seven days; no invitation email is sent by the app. Owners may appoint additional owners, and the last owner cannot leave, be demoted, or have their Auth account deleted without transferring ownership first. Access changes are audited. New accounts do not receive fabricated identities, seeded tenants, or automatic access to other organizations.

The gateway limits pre-authentication traffic by source IP and authenticated requests by subject. The default source IP budget is shared when requests arrive through the provided reverse proxy, which is suitable for a small workspace. Adapt trusted proxy handling and budgets to your deployment before scaling traffic.

## Storage and operations

Compose persists `/app/data/workspace.sqlite` in the `workspace-data` named volume. Back up before upgrading from the personal workspace version: legacy files remain quarantined until their creator explicitly imports them into a tenant they own. Native gateway runs default to `.data/workspace.sqlite`; `DATA_PATH` overrides the filename. The database includes artifact BLOBs, templates and metadata with tenant-filtered queries, transactions and SQLite WAL. Database files are created with restricted permissions. Supabase holds the tenant directory, memberships, invitations and access audit; apply the SQL schema before use. Document bytes stay local, and no Supabase Storage bucket or service-role key is needed.

Run **one gateway process per database** on local disk. Startup marks interrupted processing jobs failed so users can resubmit; it does not silently replay document operations. For multiple gateway replicas, move this store behind a database/storage service first. SQLite files and backups are not application-encrypted: use encrypted host storage where required. Deleted records stop being accessible through the API; historical bytes may remain in SQLite pages or backups until those are reclaimed under your retention policy.

Back up the complete named volume while the gateway is stopped (`docker compose stop gateway`), then restart it (`docker compose start gateway`). Restore the database/volume with the gateway stopped as well. Do not copy only the main SQLite file from a running WAL database. `docker compose down` preserves the volume; `docker compose down -v` permanently deletes saved workspace data. Database pages are reused after deletion; a maintenance SQLite `VACUUM` can reclaim unused disk space while the gateway is stopped.

The Caddy image serves `frontend/dist` and proxies the gateway. The editor has a separate Content Security Policy for its WebAssembly worker. If serving the frontend elsewhere, preserve both policies and proxy `/api/*`; allow the Supabase project origin in the workspace `connect-src` policy.

## API

All endpoints below require a verified bearer token. Document endpoints require `X-Tenant-Id` and a current membership. Processing and template writes require a tenant operator/admin/owner role. IDs are opaque UUIDs and tenant scope is checked on every access.

| Method | Endpoint | Result |
| --- | --- | --- |
| POST | `/api/docx/generate` | DOCX attachment; supply `{templateId, values}`, `{savedTemplateId, values}`, or `{filename, file, values}` |
| POST | `/api/pdf/convert` | PDF attachment; supply `{filename, file}` |
| GET | `/api/jobs?offset=0` | `{items, nextOffset}` with durable job status |
| GET | `/api/jobs/:id` | Job metadata |
| GET | `/api/jobs/:id/download` | Saved ready artifact |
| DELETE | `/api/jobs/:id` | Delete a completed/failed job and its artifact |
| GET | `/api/templates` | Selected tenant’s template metadata |
| POST | `/api/templates` | Save `{name, filename, file}` after DOCX inspection |
| GET | `/api/templates/:id/download` | Original saved DOCX template |
| DELETE | `/api/templates/:id` | Delete a saved template (creator or tenant admin/owner) |
| GET / POST | `/api/tenants` | List memberships or create a named tenant |
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

`file` is canonical base64. Successful processing responses include `X-Document-Id` for the persisted job. `/api/health` and private service `/health` routes are unauthenticated probes and do not process documents. PDF readiness includes checking the renderer.

## Checks

```sh
npm run check
```

This runs Node's built-in test runner and the TypeScript/Vite production build. Tests use temporary databases and isolated in-memory identity/tenant/renderer doubles; they never provision users or seed workspace data. They cover real DOCX rendering, persistence/restart recovery, template workflows, tenant isolation and sharing, role revocation during processing, safe personal-data migration, auth failures, signed service requests, upload validation, pagination, quotas and renderer failures.

The GitHub Actions workflow also tests tenant RLS and ownership/invitation RPCs against a disposable PostgreSQL database, then starts the pinned Gotenberg image and tests real HTML and DOCX conversion plus renderer authentication. To run that test locally against an isolated authenticated renderer, set `GOTENBERG_TEST_URL` and `GOTENBERG_TEST_PASSWORD` when running `npm test`. Without them, that one integration test is explicitly skipped. The check command can also run on a self-hosted CI runner; no CI service is required by the application.

## Dependency notices

The frontend build produces `/third-party-notices.txt` with bundled dependency and font notices. Runtime npm packages retain their own license files. No paid editor modules or commercial Docxtemplater add-ons are used. Storage uses Node's built-in SQLite module rather than an additional package. See [third-party inventory and sources](THIRD_PARTY_NOTICES.md) before redistributing container images.
