# Gateway request limits

Set these optional environment variables on the gateway. Each budget has a one-minute window starting with its first accepted request. A request that exceeds a budget receives HTTP 429 and a `Retry-After` header with the remaining delay in seconds. Wait at least that long before retrying. A response lost during a document mutation can leave a completed job, so check the activity history before resubmitting.

| Environment variable | Default | Requests counted together |
| --- | ---: | --- |
| `RATE_LIMIT_IP_PER_MINUTE` | 120 | Ordinary API requests from one source network, including invalid credentials |
| `RATE_LIMIT_TOKEN_PER_MINUTE` | 20 | OAuth token exchanges from one source network, including failed exchanges |
| `RATE_LIMIT_WEBHOOK_PER_MINUTE` | 120 | Stripe and Razorpay billing webhooks, WhatsApp webhook events and verification requests from one source network |
| `RATE_LIMIT_SUBJECT_PER_MINUTE` | 120 | All authenticated requests from a user or API client in one tenant. Account-level requests have a separate bucket per user. |
| `RATE_LIMIT_TENANT_PER_MINUTE` | 600 | All authenticated requests for one tenant, across users and API clients |
| `RATE_LIMIT_WRITE_PER_MINUTE` | 20 | Mutations from a user or API client in one tenant, or from a user on account-level routes |
| `RATE_LIMIT_TENANT_WRITE_PER_MINUTE` | 60 | All mutations for one tenant, across users and API clients |

The gateway checks source budgets before authentication. Token exchanges, webhooks and ordinary API calls each have a separate source budget. The gateway checks subject and tenant budgets after authorization and before reading the request body. Mutations also consume the ordinary authenticated budgets. The tenant comes from verified access. Rotating an access token retains the same user or client budget. Some sensitive routes also have fixed caps, including ten organization creations per user per minute. The constant-response health probe remains available during throttling.

Each user or API client can request up to 60 live DOCX previews per minute in an organization. Previews count toward the normal source, subject and tenant budgets. The mutation budget remains available for generating and saving documents.

## Behind a reverse proxy

By default, the gateway uses the immediate TCP peer. Users reaching it through Caddy may share a source budget. To distinguish clients, set `RATE_LIMIT_TRUSTED_PROXIES` to a comma-separated list of your ingress proxy IPs or their dedicated CIDRs. Configure the edge proxy to overwrite client-supplied forwarding headers and restrict direct access to the gateway. Include only proxies you operate. The gateway reads the forwarded chain from the nearest peer up to the first untrusted address. Each IPv4 address or IPv6 /64 has its own budget.

## Storage and deployment

The gateway saves rate counters alongside its workspace database in `<DATA_PATH>.limits.sqlite`. It commits each set of authenticated counters in one SQLite transaction. If an individual client is throttled, that request leaves the tenant's authenticated budget available for its other clients. Counters survive a normal restart with the same volume. Traffic triggers expired-counter cleanup at most once per minute. SQLite limits the counter database to 8,192 pages. If the store is full, locked beyond the short timeout or unavailable, the gateway returns HTTP 503 with `Retry-After`.

Use one gateway process per workspace volume, as required by the existing document store. Gateways on separate volumes have independent counters. For a replicated deployment, move workspace state and rate enforcement to shared services. These quotas cover the gateway. A separately exposed Supabase Auth or PostgREST endpoint needs limits at its own ingress.
