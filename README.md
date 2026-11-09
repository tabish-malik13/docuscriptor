# DocuScripter

A proprietary document workspace using self-hostable open-source components. The hosted version runs on Cloudflare Pages and Supabase, with no PC backend or SQLite runtime. See [project rules](AGENTS.md), [deployment guide](docs/deployment.md), and [third-party notices](THIRD_PARTY_NOTICES.md).

**Live:** https://docuscriptor.pages.dev

## Hosted workspace

Sign in with a verified account, create an organization or accept an invitation, and open `/org/<organization>`. Organization settings manage membership, roles, invitations, and access history. No demo users, organizations, or documents are seeded.

The **Documents** page uploads DOCX/PDF files up to 4 MB to a private Supabase Storage bucket. Postgres stores metadata and protects it with row-level security. Members share organization files; viewers can download; operators upload and delete their own files; owners/admins manage organization content. Every API request verifies the user's identity and current membership, and Storage repeats authorization with that user's token. A publishable key does not grant document access.

The **DOCX editor** creates or opens a Word document in your browser. Download your edits, then upload the file to Documents if you want to save it to your organization. Editor state remains in browser memory until downloaded. The editor is available without signing in and does not perform server processing.

DOCX generation, template processing, and PDF conversion are **not supported in the hosted release**. Their code remains separately deployable in `backend/docx`, `backend/pdf`, and the optional Fastify gateway. The hosted API does not contact those services, regardless of client flags. Existing local documents have not been imported.

## Cloud deployment

The Pages Worker handles organizations and file operations directly against Supabase Auth, Postgres, and private Storage. No tunnel, local database or local server is involved. The application reserves up to 768 MiB across organizations and 256 MiB per organization to stay below Supabase's current free file-storage allowance. See [deployment and operations](docs/deployment.md) for setup, free limits, retry behavior and configuration.

```sh
npm ci
PUBLIC_APP_ORIGIN=https://docuscriptor.pages.dev npm run build:pages
npx --yes wrangler@4.158.0 pages deploy frontend/dist --project-name docuscriptor --branch main
```

Configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as described in `.env.example`. Apply the Supabase migrations before deployment. Never expose secret or service-role keys in frontend variables.

## Browser editor development

Use Node 24+:

```sh
npm ci
npm run dev:web
```

Open http://127.0.0.1:5173/editor.html. The editor needs no backend. The old temporary backend preview is no longer part of the hosted architecture.

## Optional processing services

The existing DOCX/PDF code is retained for future self-hosted use. Identity, document generation and conversion remain separately deployable. The web app uses a gateway for document operations; processing services use private Docker networks. The gateway verifies identity, membership and role before issuing service-specific HMAC assertions bound to the user, organization, payload and expiry. The PDF renderer additionally requires Basic authentication.

The optional Compose stack requires three distinct server secrets (`DOCX_SERVICE_SECRET`, `PDF_SERVICE_SECRET`, `GOTENBERG_PASSWORD`) and the configured Supabase schema. These secrets must never be uploaded to Pages. `docker compose up --build -d` runs the optional stack; `npm run dev` runs the optional native services and Vite. These commands are unnecessary for the live cloud-only release. The normal gateway now uses Supabase persistence; the historical SQLite adapter remains only to verify regression fixtures, and is not used in production.

The retained processing code validates DOCX/ZIP uploads, restricts template expressions, disables renderer macros/JavaScript/outbound document requests, limits concurrent operations, and checks permission again before saving a result. No hosted processing capability is enabled by retaining this code.

## Checks

```sh
npm run check
```

Tests cover cloud API authorization, private file persistence, checksum verification, deletion ordering, organization access, and the retained processing code. SQLite appears only in isolated historical regression fixtures. GitHub Actions also verifies organization and document RLS against disposable PostgreSQL and exercises real Gotenberg conversion. Real-renderer tests are explicitly skipped locally unless `GOTENBERG_TEST_URL` and `GOTENBERG_TEST_PASSWORD` are set.

## Dependency notices

The frontend build emits `/third-party-notices.txt`. Runtime packages retain upstream notices. No paid editor modules or commercial Docxtemplater add-ons are used. Cloudflare is an optional deployment adapter; the app remains self-hostable. The MIT-licensed esbuild package bundles the serverless gateway during the Pages build.
