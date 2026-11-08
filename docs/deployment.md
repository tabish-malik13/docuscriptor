# Free frontend with a temporary local backend

This deployment uses Cloudflare Pages' free plan for static React assets and a small API proxy, your existing Supabase project for Auth and organization Postgres data, and your computer for the gateway/DOCX/PDF containers. No domain purchase is required. The app remains self-hostable; Cloudflare is an optional deployment adapter.

The frontend address is `https://<actual-project>.pages.dev`, subject to availability. Organization links are `/org/<slug>` on the same origin. All organizations share browser sign-in state; organization membership and document roles are still checked on every gateway request. Subdomain mode remains available for later custom-domain deployment.

## First deployment

1. Install Node 24+, Docker, and the Apache-2.0 licensed [cloudflared CLI](https://github.com/cloudflare/cloudflared). On macOS: `brew install cloudflared`.
2. Preserve the configured root `.env`. It needs the Supabase public URL/publishable key and three distinct server secrets described in `.env.example`. Never upload `.env` or server secrets to Pages.
3. Authenticate the optional MIT/Apache-2.0 licensed Wrangler CLI:

   ```sh
   npx --yes wrangler@4.158.0 login
   npx --yes wrangler@4.158.0 pages project create docuscriptor --production-branch main
   ```

   If the name is unavailable, choose another project name and use the actual address returned by Cloudflare throughout the following steps. Do not upgrade to a paid plan.

4. Start the backend preview in a terminal that stays open:

   ```sh
   PUBLIC_APP_ORIGIN=https://docuscriptor.pages.dev npm run preview:backend
   ```

   This builds the Compose stack in a separate `docuscripter-preview` project and publishes only the web entry point on loopback port 4173. Gateway, DOCX, PDF, and renderer stay on their existing private networks. It then opens a temporary Cloudflare Quick Tunnel. Its public URL is printed and saved in gitignored `.data/preview.json`. The preview uses its own persistent Docker volume; existing native-development records are not copied or deleted.

5. In another terminal, configure the tunnel URL as the Pages runtime variable. Paste only the printed `https://…trycloudflare.com` URL when prompted:

   ```sh
   npx --yes wrangler@4.158.0 pages secret put BACKEND_ORIGIN --project-name docuscriptor
   PUBLIC_APP_ORIGIN=https://docuscriptor.pages.dev npm run build:pages
   npx --yes wrangler@4.158.0 pages deploy frontend/dist --project-name docuscriptor --branch main
   ```

   The build emits the advanced-mode `_worker.js` API proxy and organization-path fallback. It preserves separate workspace/editor Content Security Policies. Bearer credentials and organization headers are forwarded only to the configured backend, with redirects disabled. No server secrets enter the frontend build.

6. Set Supabase Auth's Site URL to the actual Pages origin and allow that origin as a confirmation redirect. Use an existing verified account; no users or organizations are seeded. Verify sign-in, organization creation/opening, Word generation, and PDF conversion before sharing the preview.

## Restarting and stopping

Quick Tunnel URLs change when restarted. Run `preview:backend` again, update `BACKEND_ORIGIN`, and redeploy Pages with the same commands. If Docker, the tunnel, or the computer stops, processing is unavailable; the frontend reports a backend-offline error. This is a development preview, not an always-on production service. Cloudflare applies free-tier request limits; no paid plan is required by this configuration.

Ctrl+C stops the tunnel. To stop the preview containers while preserving saved records:

```sh
docker compose -p docuscripter-preview -f compose.yaml -f compose.preview.yaml down
```

Do not add `-v`: that deletes the preview's saved documents. Keep one gateway process per SQLite database. Stop the gateway before backing up the complete volume, including SQLite WAL files.

## Current storage split

Supabase Postgres holds organizations, memberships, invitations and access audit. The gateway's existing SQLite store holds job metadata, generated document bytes and saved templates. SQLite needs no additional server or npm dependency and supports local/offline storage, but requires a durable local disk and one gateway process. It is not suitable for ephemeral serverless filesystems.

For an always-on cloud deployment, a future storage migration should put job/template metadata in Postgres and file bytes in private Supabase Storage buckets, with membership-based RLS, quota handling and an explicit migration of existing records. That migration is separate from this preview configuration; existing files are not silently moved to the cloud. DOCX and PDF engines still need compute even after moving storage.

References: [Pages direct upload](https://developers.cloudflare.com/pages/get-started/direct-upload/), [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/), [Quick Tunnel limitations](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
