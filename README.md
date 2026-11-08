# DocuScripter

DocuScripter is an open-source-powered document workspace with Supabase Auth, browser-based Word editing, and self-hosted DOCX and PDF processing. See [project rules](AGENTS.md).

## Run the editor locally

Use Node.js 24 or later.

```sh
npm ci
npm run dev
```

Open the [DOCX editor](http://127.0.0.1:5173/editor.html) to create a blank document or edit a DOCX and download the result. The editor works without a Supabase project because the document stays in the browser. Use **Download DOCX** before leaving the page. The [workspace](http://127.0.0.1:5173/) requires a Supabase account to sign in.

## Connect Supabase Auth

1. Use your hosted or [self-hosted Supabase project](https://supabase.com/docs/guides/self-hosting/docker). Enable email/password authentication. For an administrator-managed workspace, disable public and anonymous sign-ups and provision your users through Supabase.
2. Copy `.env.example` to `.env`. Set `VITE_SUPABASE_URL` to the project origin and `VITE_SUPABASE_PUBLISHABLE_KEY` to its `sb_publishable_…` key. Keep secret and service-role keys out of the browser environment. For self-hosted projects, [enable publishable API keys](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys).
3. To allow a user to generate DOCX or PDF, set `app_metadata.workspace_role` to `document-operator` or `workspace-admin` with the [Supabase Auth Admin API](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid) from a trusted admin environment. Other signed-in users have viewer access. For example, call `supabase.auth.admin.updateUserById(userId, { app_metadata: { workspace_role: 'document-operator' } })` using a server-side admin client.
4. Start the app containers and open the [workspace](http://localhost:4173/).

```sh
docker compose up --build -d
```

For a Supabase instance running on the same host as the app containers, set `SUPABASE_GATEWAY_URL` to its container-reachable gateway origin while keeping `VITE_SUPABASE_URL` browser-reachable. On Docker Desktop, this can be `http://host.docker.internal:54321`. Use your container runtime's host address when it differs.

Supabase Auth replaces the previous Keycloak integration. Existing Keycloak users need accounts in the Supabase project.

## Deploy frontend and backend

| Directory or component | Deployment |
| --- | --- |
| `apps/web` | Vite static frontend. Run `npm run build` from the repo root and serve `apps/web/dist` over HTTPS. |
| Supabase Auth | Hosted Supabase or the separately self-hosted Supabase stack. |
| `services/gateway` | Fastify API. Configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `DOCX_SERVICE_URL`, and `PDF_SERVICE_URL`. It verifies each bearer token against Supabase Auth and uses trusted app metadata for authorization. |
| `services/docx` | Private Fastify service for Word templates. |
| Gotenberg | Private container with LibreOffice and Chromium for PDF conversion. |

The frontend and backend have separate npm workspaces and container build targets. The provided Caddy configuration serves the frontend and proxies `/api/*` to the gateway. If hosting the static frontend elsewhere, configure the host's `/api/*` reverse proxy to the gateway and preserve the separate CSP for `/editor.html`. Update the workspace CSP to allow the Supabase project origin. Keep the DOCX and PDF containers on a private network.

Hosted Supabase Edge Functions use Deno and deploy function code. The React build and these Node.js/LibreOffice/Chromium containers run on their own hosts. Supabase currently supplies Auth for DocuScripter. Document storage and durable job history still need an implementation. [Edge Functions deployment model](https://supabase.com/docs/guides/functions/quickstart)

## Processing

The gateway accepts authenticated requests at `POST /api/docx/generate` and `POST /api/pdf/convert`. It handles files up to 4 MB synchronously and returns downloadable artifacts. Recent activity starts empty and tracks results from the current workspace session. DOCX templates accept simple text placeholders such as `{customer_name}`. The PDF converter accepts DOCX and self-contained UTF-8 HTML. The converter runs without macros, browser scripts, or outbound network requests.

## Dependency licenses

The editor uses EigenPal's Apache-2.0 React and core packages. DOCX generation uses Docxtemplater core under MIT. The Gotenberg API is MIT-licensed and bundles LibreOffice under MPL-2.0 alongside components with their own licenses. The web build includes bundled dependency and font licenses at `/third-party-notices.txt`. Verify container component licenses before redistributing images.
