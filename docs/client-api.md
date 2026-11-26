# Connect a server application

Open **Organization settings → API clients** as an owner or admin. Create a client for the integration, select its permissions, and save the client ID and one-time secret in your server's secret store. For a service that only converts files to PDF, select **Convert DOCX or HTML to PDF**. The same credential setup works for the optional [WhatsApp adapter](whatsapp.md).

Use the OAuth 2.0 client credentials grant over HTTPS. Send HTTP Basic credentials to `POST /api/oauth/token` and a URL-encoded body with `grant_type=client_credentials`. An optional space-separated `scope` narrows the grant for that token. The response contains `access_token`, `token_type`, `expires_in` (900 seconds), and `scope`. Keep the token server-side and reuse it until shortly before expiry. [OAuth client credentials grant](https://www.rfc-editor.org/rfc/rfc6749#section-4.4)

### Convert a file

With Node 24 installed, set `DOCUSCRIPTER_ORIGIN` to the public HTTPS origin of your deployment and supply `DOCUSCRIPTER_CLIENT_ID` and `DOCUSCRIPTER_CLIENT_SECRET` through your environment. This example takes an input and an output path, exchanges the credential, and writes the returned PDF. Choose a new output filename.

```sh
node --input-type=module - input.docx output.pdf <<'JS'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

const [input, output] = process.argv.slice(2)
const origin = new URL(process.env.DOCUSCRIPTER_ORIGIN)
if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Use HTTPS')
const id = process.env.DOCUSCRIPTER_CLIENT_ID
const secret = process.env.DOCUSCRIPTER_CLIENT_SECRET
if (!id || !secret) throw new Error('Set the client ID and secret')
const file = await readFile(input)
const exchange = await fetch(new URL('/api/oauth/token', origin), {
  method: 'POST', redirect: 'error',
  headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64') },
  body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'documents:convert' }),
})
if (!exchange.ok) throw new Error('Token exchange failed, HTTP ' + exchange.status)
const { access_token } = await exchange.json()
const response = await fetch(new URL('/api/pdf/convert', origin), {
  method: 'POST', redirect: 'error',
  headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ filename: basename(input), file: file.toString('base64') }),
})
if (!response.ok) throw new Error('Conversion failed, HTTP ' + response.status + ' ' + await response.text())
await writeFile(output, Buffer.from(await response.arrayBuffer()), { flag: 'wx' })
console.log('Saved', output, 'for job', response.headers.get('x-document-id'))
JS
```

### Edit a saved template

For a website that edits templates its users saved in DocuScripter, have an organization owner or admin create an API client with `templates:read` and `templates:edit:organization`. This grant allows edits to any saved template in that organization. For an integration that manages only templates it creates, select `templates:read` and `templates:write` instead. An existing client keeps its original grants.

Run the integration on your server. Requests use the API client's identity, which appears as `client:<id>` in version history. If your website lets individual users trigger edits, check their access to the selected organization and template on your server before making the call. The built-in workspace uses each user's verified session and role.

Set `DOCUSCRIPTER_ORIGIN` to your public HTTPS gateway origin, and supply `DOCUSCRIPTER_CLIENT_ID` and `DOCUSCRIPTER_CLIENT_SECRET` through your server environment. For local development the example also accepts an HTTP origin on `127.0.0.1` or `[::1]`. Use the ID and version from the template you reviewed. A downloaded DOCX carries its version in the `X-Template-Version` response header. The following curl and jq commands list saved templates and their current versions.

```sh
TOKEN=$(curl --fail-with-body --silent --show-error \
  --user "$DOCUSCRIPTER_CLIENT_ID:$DOCUSCRIPTER_CLIENT_SECRET" \
  --data 'grant_type=client_credentials' \
  --data-urlencode 'scope=templates:read' \
  "$DOCUSCRIPTER_ORIGIN/api/oauth/token" | jq -er '.access_token')

curl --fail-with-body --silent --show-error --header "Authorization: Bearer $TOKEN" \
  "$DOCUSCRIPTER_ORIGIN/api/templates" | jq '.items[] | {id, name, version, fields}'
```

Set `TEMPLATE_ID` and `BASE_VERSION` from the reviewed template. From the repository root, run the Node 24 example to rename a template saved by a member of the organization and replace its DOCX in the same revision. The example uses Node's built-in modules. [Runnable template editor](../examples/edit-template.mjs)

```sh
node examples/edit-template.mjs --organization \
  --id "$TEMPLATE_ID" --base-version "$BASE_VERSION" \
  --name "Master services agreement" --file ./updated-agreement.docx
```

Use `--name` alone for a rename or `--file` alone for a replacement. Omit `--organization` to edit the client's own templates with `templates:write`. The command exchanges the credentials for the selected permission, sends `PATCH /api/templates/:id`, and prints the updated metadata as JSON. If you already have the ID, `GET /api/templates/:id` returns its metadata directly.

To integrate the same function into a Node.js server, pass a function that returns a valid scoped bearer token from your server's token cache.

```js
import { editTemplate } from './examples/edit-template.mjs'

const updated = await editTemplate({
  origin: process.env.DOCUSCRIPTER_ORIGIN, getAccessToken, id,
  baseVersion: reviewedVersion, name: newName, file: updatedDocxPath,
})
```

A successful edit returns HTTP 200 with `id`, `name`, `version`, and the detected `fields`. Changed templates retain their ID. Each new revision retains the previous name and DOCX in history and counts toward storage usage. Renaming to the current name alone keeps the current version. A stale `baseVersion` returns HTTP 409. Read the latest version and review the intervening changes before reapplying your edit. Uploads accept DOCX files up to 4 MB.

To fill runtime values for a single output document, send `{savedTemplateId, values}` to `POST /api/docx/generate` with `templates:read` and `documents:generate`. That operation preserves the reusable template.

#### Edit as the signed-in user

An application that already has the user's DocuScripter Supabase session can call the same endpoint with that user's access token. Operators can edit templates they created. Owners and admins can edit any saved template in the selected organization. Viewers can read templates. In the workspace frontend, `useTenantApi().api` supplies the session and organization headers. A direct request from the workspace origin looks like this.

```js
const response = await fetch('/api/templates/' + encodeURIComponent(id), {
  method: 'PATCH',
  headers: {
    Authorization: 'Bearer ' + session.access_token,
    'X-Tenant-Id': tenant.id,
    'X-Organization-Slug': tenant.slug,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ baseVersion: reviewedVersion, name: newName }),
})
if (!response.ok) throw new Error((await response.json()).message)
const updatedTemplate = await response.json()
```

### Document permissions

The access token selects one organization. A supplied `X-Tenant-Id` must match the client. A workspace hostname in subdomain mode or an `X-Organization-Slug` in path mode must also match. A client can call the central API origin directly. Human sessions continue to use their verified identity, tenant selector, and current membership.

| Permission | Allowed operations |
| --- | --- |
| `documents:convert` | Convert DOCX or HTML to PDF and download this client's PDF output by job ID |
| `documents:generate` | Preview or generate a DOCX, download this client's DOCX output, and manage its own batches. PDF batches also require `documents:convert`. Using a saved template requires `templates:read`. |
| `documents:read` | List tenant jobs, inspect status, and download **any** ready output in the tenant |
| `documents:delete` | Delete this client's finished or failed jobs |
| `templates:read` | List and download the tenant's saved templates and their versions |
| `templates:write` | Create a template or edit the name and DOCX of a template created by this client |
| `templates:edit:organization` | Edit the name and DOCX of any existing saved template in this organization |
| `templates:delete` | Delete templates created by this client |

The [document endpoint reference](../README.md#api) lists the paths and payloads. Authentication failures return HTTP 401. An insufficient permission or mismatched workspace returns 403. A missing or inaccessible record can return 404. Respect `Retry-After` on throttled requests. If a connection is interrupted during a mutation, inspect the workspace history before resubmitting.

For roster automation, see the [bulk generation API and retry semantics](bulk-generation.md#from-an-integration).

### Credential lifecycle

| Administrator action | Gateway route |
| --- | --- |
| Create | `POST /api/tenant/clients` with `{"name":"Billing converter","scopes":["documents:convert"]}` |
| List | `GET /api/tenant/clients?offset=0` returns `items` and `nextOffset` |
| Rotate secret | `POST /api/tenant/clients/:id/rotate` |
| Revoke client | `DELETE /api/tenant/clients/:id` |

These endpoints require a human owner or administrator session for the selected tenant. Creation and rotation return the secret once in `clientSecret`. Rotation preserves the client ID and its document ownership. Rotation and revocation invalidate its outstanding tokens immediately. The gateway rechecks credentials before committing newly processed output. Organization settings shows each creation, rotation and revocation in **Recent access changes**, with its actor, client ID and time. The client inventory also reports the creator and latest rotation and revocation details.

The grant belongs to the organization and survives the departure of its creator. Revoke clients before manually decommissioning a tenant in Supabase. Restoring the gateway database restores its credential state too. Reconcile rotations and revocations made since the backup before reopening access.
