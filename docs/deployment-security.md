# taskpapr — Security Reference

This document serves two purposes:

1. **Audit record** — what security measures are already built into the application, so you can confidently describe the security posture to users, auditors, or yourself in six months.
2. **Deployment guide** — the recommended infrastructure pattern for a public-facing deployment that protects against DDoS, resource exhaustion, and abuse without adding complexity to the Node.js layer.

---

## Part 1: What's already handled (built-in)

These protections are implemented in the application code and require no external configuration.

### SQL injection — fully mitigated

Every database query uses `node:sqlite` prepared statements with parameterised values. There is no string concatenation of SQL anywhere in `db.js` or `server.js`. Example:

```js
// Safe — value is a parameter, never interpolated
db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, uid);
```

The attack surface for SQL injection is zero.

### Authentication & authorisation

- `requireAuth` middleware is applied globally to all routes before they are registered, with explicit exceptions only for genuinely public endpoints (`/login`, `/auth/*`, `/api/telegram/webhook`).
- All data queries are scoped to `req.user.id` — a user can never read or modify another user's data, even if they know the ID of another resource.
- Session tokens are opaque random values managed by `express-session`; they are not JWTs and cannot be forged.
- Sessions are stored in the database (`sessions` table via the active adapter — SQLite locally or PostgreSQL when `DATABASE_URL` is set), not in-memory MemoryStore, so they survive server restarts and are visible to every app replica that shares that database.

### API key security

- Raw API keys are **never stored**. Only a SHA-256 hash is stored in the database.
- Keys are generated as `tp_<64 hex chars>` (256 bits of entropy), shown to the user exactly once, and cannot be retrieved again.
- The key prefix (`tp_abc123…`) is stored for display purposes only.
- The webhook endpoint (`POST /api/webhook`) requires `req.apiKeyAuthenticated = true` — session cookies are explicitly not accepted, even in single-user mode. This prevents CSRF-style attacks where a logged-in browser session is used to trigger automation.

### Telegram webhook security

- The `/api/telegram/webhook` endpoint is intentionally public (Telegram servers POST to it).
- An optional `TELEGRAM_WEBHOOK_SECRET` env var enables `X-Telegram-Bot-Api-Secret-Token` header validation, so only Telegram's servers can deliver updates.
- Messages from chat IDs not linked to any user account are silently ignored — no enumeration possible, no reply sent.

### No secrets in source

- All secrets (`SESSION_SECRET`, OAuth credentials, API keys, Telegram tokens) are in `.env` which is in `.gitignore`.
- `.env.example` documents the variables without values.
- The `SESSION_SECRET` must be set explicitly; there is no insecure fallback default in production mode.

### Dependency surface area

The application has a deliberately minimal dependency list:
- `express` — web framework
- `express-session` — session management
- `passport` + `passport-github2` + `passport-openidconnect` — OAuth/OIDC
- `dotenv` — env var loading
- `@modelcontextprotocol/sdk` — MCP server only

No ORM, no JWT library, no template engine, no heavy framework. Small surface area = fewer CVEs to track.

---

## Part 2: What v0.35.0 adds (application-layer hardening)

These are implemented in the Node.js application and apply regardless of what proxy sits in front.

### Rate limiting (`express-rate-limit`)

Three tiers, all configurable via env vars:

| Tier | Default | Env var | Applied to |
|---|---|---|---|
| Global | 300 req/min/IP | `RATE_LIMIT_GLOBAL` | All routes |
| Writes | 30 req/min/IP | `RATE_LIMIT_WRITES` | `POST /api/tasks`, `/api/columns`, `/api/goals`, `/api/bookmarks`, `/api/webhook` |
| Auth | 20 req/min/IP | `RATE_LIMIT_AUTH` | `/auth/github`, `/auth/oidc` |

Returns HTTP 429 with `Retry-After` header on breach.

### Security headers (`helmet`)

One middleware call sets all recommended HTTP security headers:
- `X-Content-Type-Options: nosniff` — prevents MIME sniffing
- `X-Frame-Options: DENY` — prevents clickjacking
- `Referrer-Policy: no-referrer` — no referrer leakage
- `X-DNS-Prefetch-Control: off`
- `Permissions-Policy` — disables unused browser features

### Input size validation

Server-side length checks on all write endpoints (frontend `maxlength` attributes are UX only, not security):

| Field | Default limit | Env var |
|---|---|---|
| Task/goal/bookmark name | 100 chars | `LIMIT_NAME_LEN` |
| Task title | 500 chars | `LIMIT_TITLE_LEN` |
| Task notes | 50,000 chars (~50KB) | `LIMIT_NOTES_LEN` |

Returns HTTP 400 with a descriptive error message.

Also: `express.json()` body parser size is explicitly set to `200kb` (was implicit 100kb default).

### Per-user resource quotas

Count check before every insert; returns HTTP 429 if the user has reached their limit:

| Resource | Default limit | Env var |
|---|---|---|
| Tasks per user | 2,000 | `LIMIT_TASKS` |
| Tiles per user | 50 | `LIMIT_TILES` |
| Goals per user | 50 | `LIMIT_GOALS` |
| Bookmarks per user | 20 | `LIMIT_BOOKMARKS` |

Applies to all insert paths: REST API, webhook, and Telegram quick-capture.

Self-hosting users can raise all limits freely. A cautious public deployment might lower them initially.

All limits are read at startup from a single `const LIMITS = { ... }` block in `server.js` — one place to inspect, one place to change.

### CI: dependency audit

`npm audit --audit-level=high` added to the `smoke-test` CI job. Fails CI on high or critical CVEs. Low/moderate are reported but non-blocking.

---

## Part 3: Recommended infrastructure pattern

This section describes the deployment architecture that protects against volumetric DDoS, hides your server's IP, and adds a second rate-limiting layer in front of the application.

### The pattern

```
Internet
    │
    ▼
Cloudflare (free tier)
  - Absorbs volumetric DDoS
  - Hides your VPS IP address
  - Edge rate limiting
  - Bot score filtering
    │  (only Cloudflare IPs reach your VPS)
    ▼
VPS firewall
  - Port 80/443 open
  - Port 3033 bound to 127.0.0.1 only (never exposed)
    │
    ▼
Traefik (Docker, on VPS)
  - TLS termination (Let's Encrypt)
  - Rate limiting (second layer, catches abuse from Cloudflare IPs)
  - Request body size limit
  - HSTS header
  - Forwards to taskpapr:3033
    │
    ▼
taskpapr (Node.js, port 3033, bound to localhost)
  - Application-layer rate limiting (third layer, helmet, quotas)
```

Three independent layers of rate limiting means an attacker has to defeat all three, and any single layer is sufficient to protect the layers behind it.

### Why Cloudflare (free tier is sufficient)

- **Volumetric DDoS mitigation** — Cloudflare absorbs bandwidth attacks before they reach your VPS. Your VPS never sees the traffic, so there are no egress charges. This is the "5-figure AWS bill" prevention.
- **Your VPS IP is never exposed** — traffic reaches you only through Cloudflare's anycast network. Even if someone discovers your domain, they cannot directly attack your VPS IP because they don't know it.
- **Free tier includes**: DDoS protection, CDN, basic rate limiting rules, bot score, "I'm Under Attack" mode.
- **"I'm Under Attack" mode** — can be toggled on instantly via Cloudflare dashboard if you're actively under attack; presents a JS challenge to all visitors for 5 seconds.

Setup steps:
1. Register domain on Cloudflare (or transfer existing domain)
2. Set DNS A record pointing to your VPS IP, with the proxy (orange cloud) enabled
3. Set SSL/TLS mode to "Full (strict)" — Cloudflare encrypts to origin, Let's Encrypt provides the cert
4. Enable "Always Use HTTPS" in SSL/TLS settings
5. Optionally create a rate limit rule: > 100 req/min from a single IP → block for 1 minute

### Traefik configuration

The existing `deploy/taskpapr-dev-traefik-dynamic.yaml` is a starting point. For a hardened public deployment, extend it as follows:

#### Rate limiting middleware

```yaml
# traefik-dynamic.yaml
http:
  middlewares:
    taskpapr-ratelimit:
      rateLimit:
        average: 100      # requests per period
        period: 1m
        burst: 50         # allow short bursts
    
    taskpapr-secure-headers:
      headers:
        stsSeconds: 31536000          # HSTS: 1 year
        stsIncludeSubdomains: true
        forceSTSHeader: true
        contentTypeNosniff: true
        frameDeny: true
        referrerPolicy: "no-referrer"
    
    cloudflare-only:
      ipWhiteList:
        sourceRange:
          # Cloudflare IPv4 ranges (update periodically from https://www.cloudflare.com/ips/)
          - "173.245.48.0/20"
          - "103.21.244.0/22"
          - "103.22.200.0/22"
          - "103.31.4.0/22"
          - "141.101.64.0/18"
          - "108.162.192.0/18"
          - "190.93.240.0/20"
          - "188.114.96.0/20"
          - "197.234.240.0/22"
          - "198.41.128.0/17"
          - "162.158.0.0/15"
          - "104.16.0.0/13"
          - "104.24.0.0/14"
          - "172.64.0.0/13"
          - "131.0.72.0/22"
          # Cloudflare IPv6 ranges
          - "2400:cb00::/32"
          - "2606:4700::/32"
          - "2803:f800::/32"
          - "2405:b500::/32"
          - "2405:8100::/32"
          - "2a06:98c0::/29"
          - "2c0f:f248::/32"

  routers:
    taskpapr:
      rule: "Host(`yourdomain.com`)"
      entryPoints:
        - websecure
      middlewares:
        - cloudflare-only       # reject non-Cloudflare traffic
        - taskpapr-ratelimit    # rate limit
        - taskpapr-secure-headers
      service: taskpapr
      tls:
        certResolver: letsencrypt

  services:
    taskpapr:
      loadBalancer:
        servers:
          - url: "http://172.17.0.1:3033"
```

#### Request body size limit (Traefik)

Add to your static Traefik configuration:

```yaml
# traefik.yml (static config)
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ":443"
    http:
      middlewares:
        - taskpapr-secure-headers@file
    transport:
      respondingTimeouts:
        readTimeout: 30s
        writeTimeout: 30s
        idleTimeout: 120s
```

### VPS firewall rules

Ensure port 3033 is never directly accessible from the internet. On a typical VPS with `ufw`:

```bash
# Allow SSH (adjust port if non-standard)
ufw allow 22/tcp

# Allow HTTP/HTTPS (Traefik)
ufw allow 80/tcp
ufw allow 443/tcp

# Block direct access to the app port
# (taskpapr binds to 127.0.0.1:3033 by default — this is belt-and-suspenders)
ufw deny 3033

ufw enable
```

Verify taskpapr only listens on localhost:
```bash
ss -tlnp | grep 3033
# Should show: 127.0.0.1:3033  (NOT 0.0.0.0:3033)
```

If it shows `0.0.0.0:3033`, set `HOST=127.0.0.1` in your `.env` file and update `server.js` to bind accordingly.

---

## Part 4: What deliberately stays out of scope

These are security concerns that exist, but are correctly handled at the infrastructure layer — **do not implement them in the Node.js application**:

| Concern | Where it belongs | Reason |
|---|---|---|
| Volumetric DDoS | Cloudflare | Node.js cannot absorb bandwidth attacks; the process would die before it could reject traffic |
| IP blocking/allowlisting | Cloudflare or Traefik | App-level IP blocking is fragile and bypassable; proxy has better visibility |
| Custom WAF rules | Cloudflare | Cloudflare's managed rules cover OWASP Top 10 on free tier |
| CAPTCHA | OAuth providers | GitHub and OIDC providers already use CAPTCHA on their login flows |
| Bot detection | Cloudflare bot score | Free tier provides basic bot scoring; tunable without app changes |
| TLS/HTTPS | Traefik + Let's Encrypt | Never terminate TLS in Node.js directly |
| DDoS at the auth layer | Cloudflare + app rate limiter | The OAuth redirect itself is low-cost; the IdP absorbs actual auth load |

Adding these to the application would increase complexity, increase attack surface (buggy blocklist logic), and provide weaker protection than the proxy layer. Keep Node.js thin.

---

## Part 5: Ongoing hygiene

- **`npm audit`** runs in CI on every push. Check the output.
- **Dependabot** — enable on the GitHub repo (Settings → Code security → Dependabot alerts + Dependabot security updates). Sends PRs for dependency vulnerabilities automatically.
- **Cloudflare IP ranges** — Cloudflare publishes their current IP ranges at `https://www.cloudflare.com/ips/`. Review the Traefik allowlist when updating Traefik config. Ranges rarely change but do occasionally.
- **Session secret rotation** — if `SESSION_SECRET` is ever compromised, rotate it (all active sessions will be invalidated; users will need to log in again).
- **Review user list** — `/admin` shows all registered users. Periodically verify no unexpected accounts have been created.
