# Organization licenses and payments

Open **Billing & plans** in an organization workspace as its owner. The page shows its current license, storage use, saved templates and retained jobs. With online billing enabled, the owner can choose a tier and a provider, see the recurring price and schedule at hosted checkout, resume a pending checkout and check payment status. Prices, currencies and intervals come from the merchant account.

## Choose a deployment mode

| Gateway configuration | Owner experience |
| --- | --- |
| `BILLING_MODE=self-hosted` (default) | Current self-hosted allowances and usage. The workspace runs independently of payment providers. |
| `BILLING_MODE=managed`, both providers disabled | Organizations start on Starter. Operators can assign Plus or Ultimate under an invoice or other contract. |
| `BILLING_MODE=managed`, at least one provider enabled | Owners without an existing contract or subscription can purchase Plus or Ultimate through an enabled provider. |

Each license covers one organization and its authorized users and API clients.

| Default allowance | Starter or self-hosted | Plus | Ultimate |
| --- | ---: | ---: | ---: |
| Storage | 256 MiB | 1 GiB | 5 GiB |
| Saved templates | 100 | 250 | 1,000 |
| Retained jobs | 1,000 | 5,000 | 25,000 |

Retained jobs count records currently in Activity, including failed and processing jobs. Deleting a completed job frees its history slot and stored output. Storage includes template versions, retained outputs, queued batch data and a 16 MiB reservation for each in-flight output. After a downgrade, existing saved records remain accessible. The gateway rejects a write that would exceed the effective allowance. The owner can free space or change the license and retry. Processing concurrency and request rate limits are configured separately. [Rate limits](rate-limits.md)

## Configure an optional payment provider

The gateway reads the settings in the root `.env` or its service environment at startup. Use the unprefixed gateway settings in the table below. Choose the actual price, currency and billing interval before creating a recurring price or plan for each tier. Keep the chosen merchant environment, plan IDs and webhook credentials together. Give the gateway permission to create hosted subscriptions or Checkout Sessions and read subscriptions and their invoices. Test in the provider sandbox before enabling real payments.

| Setting | Stripe | Razorpay |
| --- | --- | --- |
| Enable checkout | `STRIPE_BILLING_ENABLED=true` | `RAZORPAY_BILLING_ENABLED=true` |
| API credentials | `STRIPE_SECRET_KEY` | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` |
| Signing secret for this webhook endpoint | `STRIPE_WEBHOOK_SECRET` | `RAZORPAY_WEBHOOK_SECRET` |
| Plus recurring price or plan ID | `STRIPE_PLUS_PRICE_ID` (`price_…`) | `RAZORPAY_PLUS_PLAN_ID` (`plan_…`) |
| Ultimate recurring price or plan ID | `STRIPE_ULTIMATE_PRICE_ID` (`price_…`) | `RAZORPAY_ULTIMATE_PLAN_ID` (`plan_…`) |
| Subscription term | Set the interval on each recurring price | Set the interval on each plan and `RAZORPAY_TOTAL_COUNT` to the number of installments your offer includes |

1. Set `FEATURE_BILLING=true` and `BILLING_MODE=managed`. Enable and configure the providers you intend to offer. Each provider needs a distinct ID for each tier and a fixed recurring price for one organization.
2. Register the public HTTPS gateway webhook in that provider's dashboard. A stable public application origin can receive both providers' events. Forward the raw request and its signature through your ingress.
   - **Stripe** uses `/api/billing/webhooks/stripe`. Select `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid` and `invoice.payment_failed`. The API adapter uses version `2026-11-18.endive`. [Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment) · [Stripe subscription events](https://docs.stripe.com/billing/subscriptions/webhooks)
   - **Razorpay** uses `/api/billing/webhooks/razorpay`. Select the subscription events `authenticated`, `activated`, `charged`, `completed`, `updated`, `pending`, `halted`, `paused`, `resumed` and `cancelled` under the `subscription.` prefix. [Create a Razorpay subscription](https://razorpay.com/docs/api/payments/subscriptions/create-subscription/) · [Webhook verification](https://razorpay.com/docs/webhooks/validate-test/)
3. Restart the native gateway or recreate the Compose gateway. In **Billing & plans**, choose a test tier and provider, open checkout and confirm the displayed amount and interval. Stripe returns the owner to the purchasing organization. A successful return triggers a payment status check. A canceled return lets the owner resume the checkout later. For Razorpay, reopen the workspace and choose **Check payment status**.
4. Confirm the license and its allowances change for the purchasing organization. Repeat with a canceled checkout and a failed renewal. The gateway verifies payment with the merchant API on a signed webhook or owner status check. For Stripe it grants the lower of the selected tier and the tier covered by a paid invoice line for the same subscription item and current billing period. An unbilled upgrade from Plus keeps Plus while its paid coverage is verifiable. A delayed payment can be confirmed after the owner closes the browser. [Stripe invoice line items](https://docs.stripe.com/api/invoice-line-item/object)

The merchant handles plan changes, subscription cancellation, invoices, tax settings and refunds in the provider dashboard. Keep configured price and plan IDs stable for existing subscribers. Coordinate a provider-side migration before replacing a mapping so existing subscribers keep their entitlements. Switching off a provider disables its checkout, webhooks and status refresh. Setting `FEATURE_BILLING=false` disables these for both providers and hides the billing page. Previously verified subscription access expires at the recorded period end. Provider-side charges continue until canceled in the merchant dashboard. After re-enabling a provider, use **Check payment status** to reconcile its subscription.

## Assign an invoice or contract license

Create a JSON file outside the checkout and set `BILLING_LICENSES_FILE` to its absolute path. Replace the bracketed placeholder with the customer's **Tenant ID** from **Organization settings → API clients**. The optional `plans` entry overrides limits for all organizations on that tier. The optional `licenses` entry assigns a tier to a particular tenant. The gateway validates these settings at startup.

```json
{
  "plans": {
    "plus": { "savedTemplates": 300 }
  },
  "licenses": {
    "<actual organization UUID>": {
      "plan": "ultimate",
      "expiresAt": "2027-06-01T00:00:00Z"
    }
  }
}
```

Use lowercase `plus` or `ultimate`. Omit `expiresAt` for an open-ended agreement. Limits can override `storageBytes`, `savedTemplates` or `retainedJobs` using positive integers. Restart the gateway after changing the file. For Compose, mount the file read-only using `docker compose -f compose.yaml -f compose.licenses.yaml up -d gateway`. The preview launcher selects this overlay automatically when the file is configured.

A current contract takes precedence over a subscription and prevents another checkout. An existing merchant subscription continues charging until canceled. Coordinate cancellation with the merchant when moving a paying customer to an invoiced contract. After contract expiry the gateway evaluates any confirmed, current subscription, then falls back to Starter.

## Recover an interrupted checkout

Each organization can have one open checkout or subscription. **Check payment status** asks the gateway to reconcile the existing attempt. A timeout after the provider receives a creation request can leave the local attempt without a checkout ID. Use the original attempt to investigate before allowing a second purchase.

- If the merchant dashboard shows a subscription, retry its webhook or send the verified subscription ID in an owner-authenticated `POST /api/billing/refresh` with `{"subscriptionId":"sub_…"}`. The gateway checks the tenant and attempt against the provider's record.
- If the merchant confirms it has **no checkout or subscription that can still charge** for the attempt, stop the gateway and use the local recovery command below. The release checks the organization, provider and attempt ID together and records the reason. Run against the same `DATA_PATH` used by the stopped gateway. Set `TENANT_ID` to the organization UUID and `ATTEMPT_ID` to the ID returned by `show`.

```sh
node --env-file-if-exists=.env backend/billing/recover.mjs show --tenant "$TENANT_ID" --provider razorpay
node --env-file-if-exists=.env backend/billing/recover.mjs release --tenant "$TENANT_ID" --provider razorpay --attempt "$ATTEMPT_ID" --confirmed-absent --reason "Merchant case reference"
```

Use `stripe` for a Stripe attempt. Restart the gateway after reconciliation. Managed billing keeps its SQLite database at `DATA_PATH` with the suffix `.billing.sqlite`. Back up the stopped gateway's entire data directory and the operator-managed license file together. Use one gateway process per SQLite volume.
