# WhatsApp document commands

An enrolled sender can message a business number, attach a Word file, and receive a generated DOCX or PDF in the same chat. The self-hosted gateway handles the webhook. It calls the same document APIs as other clients and records results in the selected workspace. Enabling this channel sends messages and document bytes through Meta's WhatsApp Business Platform. The base DocuScripter deployment runs independently of Meta. Meta's messaging policies, service window, and pricing apply when the channel is enabled. [Meta pricing and service windows](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)

## Connect an organization from the workspace

Enable `FEATURE_WHATSAPP` and `FEATURE_API_CLIENTS` in the gateway. Disabling either suspends the webhook and removes WhatsApp settings from the workspace. Saved connections are available again when both flags are enabled. [Deployment feature flags](../README.md#deployment-feature-flags)

An owner or administrator can configure one WhatsApp Business number in **Organization settings → WhatsApp**. Changes apply as soon as they are saved. Use this flow when an organization manages its own Meta app and business number.

1. Under **Organization settings → API clients**, create a client for this connection and copy its one-time secret. For a number that only converts Word files to PDF, select **Convert DOCX or HTML to PDF**. The command table below lists the scopes for other actions.
2. In **Organization settings → WhatsApp**, add a connection. Enter the registered **phone number ID** from Meta, your app’s Graph API version, app secret and system-user access token with `whatsapp_business_messaging` access to that number. Select the workspace API client, enter its secret and list the senders allowed to use it. Use international phone numbers as digits, including the country code, or exact Meta business-scoped user IDs. Confirm each sender is authorized to use this client’s document permissions. [Meta Cloud API setup](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started)
3. Save the connection. Copy the **callback URL** and the one-time **verification token** into your Meta app’s WhatsApp webhook configuration. Subscribe the app to your WhatsApp Business Account and its **messages** field. The callback must be publicly reachable over HTTPS. You can prepare the connection locally, then use your public deployment or HTTPS preview for Meta verification. [Meta webhook setup](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint) · [Deployment guide](deployment.md)
4. Choose **Check status** in WhatsApp settings to see whether the callback challenge succeeded. To confirm the sender, client credentials and Meta messaging permissions together, send `help` from an enrolled number. Then send a small DOCX attachment with the caption `pdf` and check the reply and the job in **Activity**. For a Meta test number, add the sender as an allowed test recipient first.

Each organization’s callback has its own address under `/api/integrations/whatsapp/webhook/<connection-id>`. The gateway verifies the signature using that connection’s app secret, checks the business number and sender, and calls the document API with its selected organization client. Use an organization-owned Meta app with its own signing secret for this setup. When one operator controls a shared Meta app for several customers, the deployment-managed bindings below let that operator retain its app secret. [Meta webhook configuration](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview)

**Edit** updates credentials or enrollment. Leaving a secret field blank keeps its saved value. Pending messages from the previous settings are discarded so an earlier request cannot run with a different client or sender list. If the one-time verification token is lost, rotate it and update Meta. **Disconnect** removes the workspace connection and disables its callback. Remove the callback subscription in Meta when retiring the integration. The workspace API client can also be revoked separately in **API clients**.

### Gateway storage and backup

The gateway stores organization connection credentials encrypted with AES-256-GCM in `<DATA_PATH>.whatsapp-connections.sqlite`. By default the gateway generates a private local key at `<DATA_PATH>.whatsapp.key`. Persist the gateway data volume and back up the stopped gateway’s data and key under restricted access. Operators who manage keys separately can set the gateway-only `WHATSAPP_ENCRYPTION_KEY` to a stable 32-byte key encoded as standard base64 before provisioning connections. Generate one with `openssl rand -base64 32`. Keep the original encryption key after disconnecting the last organization. The gateway retains a keyed fingerprint so a previously used app signing secret cannot authenticate a different organization.

## Deployment-managed bindings

Operators can also provision a shared callback with multiple bindings from a server-side file. The existing file format and callback address are supported. The WhatsApp panel shows the number of file-managed business numbers for the current organization. A phone number or signing secret managed by the deployment file is reserved for that configuration. If a later file change takes over a workspace connection, its organization callback stops accepting events and the panel shows the conflict. To move the number into organization settings, remove its file binding, remove the file setting if no bindings remain, restart the gateway, then complete the workspace setup above.

If a later deployment file uses a signing secret previously supplied by a workspace, the gateway also disables the shared callback and its queued work. Configure a fresh signing secret for the deployment’s Meta app and restart the gateway to resume that callback.

1. In the intended workspace, have an owner or administrator create an API client. For a conversion-only channel, select **Convert DOCX or HTML to PDF** (`documents:convert`). Copy the client ID, one-time secret, and workspace tenant UUID. See the command table below to expand access.
2. Set up the WhatsApp Cloud API for your business in the Meta App Dashboard. Register a business phone number and obtain its **phone number ID**, the app secret, and a system-user access token with `whatsapp_business_messaging` access to that number. Use a Graph API version supported by your app. Confirm each consenting sender's identity and authorized workspace with the workspace administrator before enrollment. [Meta Cloud API setup](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started) · [Meta webhook permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview)
3. Save the following JSON in an operator-managed secret file **outside the repository**. Replace every placeholder. Generate an independent verification token, for example with `openssl rand -hex 32`. Allow only the gateway runtime and its operator to read the file. In Compose the gateway runs as the image's `node` user (UID 1000).

```json
{
  "version": "v27.0",
  "appSecret": "<Meta app secret>",
  "verifyToken": "<random webhook verification token>",
  "bindings": [
    {
      "phoneNumberId": "<business phone number ID>",
      "accessToken": "<Meta system-user access token>",
      "tenantId": "<workspace UUID>",
      "clientId": "<workspace API client UUID>",
      "clientSecret": "<one-time DocuScripter client secret>",
      "senders": ["<enrolled sender identifier>"]
    }
  ]
}
```

4. Set `WHATSAPP_CONFIG_FILE` to the absolute host path in your server environment or project `.env`. For Compose, run the following command from the repository root. Native deployments read the same file when the gateway starts.

```sh
docker compose -f compose.yaml -f compose.whatsapp.yaml up --build -d
```

5. Expose the existing gateway route at **`https://<public-host>/api/integrations/whatsapp/webhook`** with a valid HTTPS certificate. Preserve the POST body bytes, query parameters, and `X-Hub-Signature-256` through any reverse proxy. Keep query strings and bodies out of proxy access logs. Enter that callback URL and the same verification token in the Meta App Dashboard. Subscribe the app to the WhatsApp Business Account and enable its **messages** field. [Meta webhook configuration](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint) · [WhatsApp Business Account subscription](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview)
6. From an enrolled sender, message `help` to the business number. Send a small DOCX as a **document attachment** with caption `pdf`. Check that the PDF arrives in that chat and the workspace shows the corresponding ready job. With a test business number, enroll the sender as an allowed test recipient in Meta's setup first.

Each binding maps a business phone number ID and explicit senders to one workspace API identity. A sender can be the digits-only international phone number from the signed message's `from` field or the exact business-scoped user ID from `from_user_id`. A business-scoped ID supports users who hide their phone number. The receiver sends the reply to the enrolled identifier from the same incoming message. A sender on two business numbers can have different workspace access. Duplicate bindings for the same number and sender are rejected. [Meta's business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids)

**The API client acts for every sender in its binding.** Its scopes determine which tenant data those senders can access, independently of their individual UI memberships. `documents:read` permits access to the tenant's document history and downloads. Senders sharing one client also share creator ownership for deletion. Use separate clients and deployment-managed bindings when senders need independent permissions or creator attribution. Remove a departed sender in the organization settings or update and reload the operator file, depending on how the number is managed.

## Commands and scopes

| Send in the chat | Gateway operation | Required client scopes |
| --- | --- | --- |
| DOCX attachment with caption `pdf`, or no caption | Convert and return PDF | `documents:convert` |
| `html <h1>Quarterly report</h1>` | Convert self-contained HTML in a chat message to PDF | `documents:convert` |
| DOCX attachment with caption `generate {"field":"value"}` | Fill the uploaded template and return DOCX | `documents:generate` |
| `generate invoice {"invoice_number":"1","customer_name":"…","description":"…","amount_due":"…"}` | Generate DOCX from a starter. Other starter IDs are `letter`, `brief` and `certificate`. | `documents:generate` |
| `generate TEMPLATE_ID {"field":"value"}` | Generate DOCX from a saved tenant template | `documents:generate`, `templates:read` |
| DOCX attachment with caption `save NAME` | Inspect fields and save a reusable template | `templates:write` |
| `templates`, `templates 2`, `fields TEMPLATE_ID`, `template TEMPLATE_ID` | List templates, show fields, or download a saved source | `templates:read` |
| `jobs`, `jobs 2`, `job JOB_ID`, `download JOB_ID` | List history, inspect status, or download a ready result | `documents:read` |
| `delete job JOB_ID` or `delete template TEMPLATE_ID` | Delete a record created by this client | `documents:delete` or `templates:delete` |
| `help` or `fields invoice`, `fields letter`, `fields brief`, `fields certificate` | Show syntax or starter field names | Any valid workspace client |

Page numbers start at 1. The PDF and DOCX commands automatically return their own result to the sender with the original processing scope. DOCX input is limited to 4 MiB and output to 16 MiB. For HTML larger than a chat message, upload the file in the browser or via the HTTP API. WhatsApp has its own supported attachment types. [Meta document attachment formats](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media/)

## Delivery and recovery

The POST handler verifies Meta's HMAC against the raw request, checks the sender and business number, and commits accepted messages to a local SQLite inbox beside `DATA_PATH` before acknowledging them. One gateway worker drains that inbox. Queued entries include sender identifiers and commands, including template values. File contents stay out of the inbox. Completion clears the command. Hashed message keys suppress repeat delivery and are eligible for cleanup after eight days.

Keep the gateway data volume when restarting. Before executing queued work, the worker checks the configured binding and verifies a scoped bearer token against the gateway's credential store. One gateway caches up to 256 tokens in memory, keyed by binding and command scope, and renews them shortly before expiry. Each document call checks the token again. Before sending an artifact or a saved receipt, the worker also checks that the token still belongs to the same client and tenant and retains the required scopes. Rotating a secret or revoking a client invalidates cached credentials immediately. It drops stale messages after 24 hours and events whose tenant or client mapping changed. Downloads use expiring URLs retrieved from Meta with the receiving phone number ID. Replies upload artifacts using Meta's authenticated media endpoint. [Meta media API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media/)

Gateway throttling, pre-processing concurrency limits, and recoverable media failures use bounded backoff. The worker honors gateway admission retry delays before submitting a mutation again. A generated job is checkpointed by ID so an upload retry can fetch the same artifact. A restart during an unconfirmed mutation produces an interruption notice. A lost acknowledgement from Meta after sending a reply leaves its outcome uncertain and suppresses another send. Gateway logs record the event hash, stage, and HTTP status for processing failures. Check workspace history before resubmitting an interrupted command. A successful send means Meta accepted the reply. Handset delivery status tracking is outside this integration.

For file-managed bindings, change the secret file and recreate the gateway with the same Compose override. Recreating the gateway with base Compose alone disables the shared file callback. Workspace connections are managed independently in Organization settings. A fresh deployment has no enrolled senders or API clients.
