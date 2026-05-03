# taskpapr — Authentication Setup Guide

taskpapr supports three login providers, any combination of which can be active simultaneously:

| Provider | When to use |
|---|---|
| **GitHub OAuth** | Quick setup; useful for personal use or when all users have GitHub accounts |
| **Google OAuth** | Natural choice for teams or individuals with Google/Workspace accounts |
| **OIDC / SSO** | When you run your own identity provider (e.g. Authentik); users authenticate via your own system |

All providers are enabled or disabled solely by the presence of the relevant environment variables in `.env`. No code changes are required.

---

## Table of Contents

- [taskpapr — Authentication Setup Guide](#taskpapr--authentication-setup-guide)
  - [Table of Contents](#table-of-contents)
  - [1. Environment file basics](#1-environment-file-basics)
  - [2. GitHub OAuth setup](#2-github-oauth-setup)
    - [2a. Create the OAuth App on GitHub](#2a-create-the-oauth-app-on-github)
    - [2b. Add to .env](#2b-add-to-env)
    - [2c. GitHub email requirements](#2c-github-email-requirements)
  - [3. Google OAuth setup](#3-google-oauth-setup)
    - [3a. Create the OAuth Client in Google Cloud Console](#3a-create-the-oauth-client-in-google-cloud-console)
    - [3b. Enable the required API](#3b-enable-the-required-api)
    - [3c. Configure the OAuth consent screen](#3c-configure-the-oauth-consent-screen)
    - [3d. Add to .env](#3d-add-to-env)
  - [4. OIDC / SSO setup (Authentik)](#4-oidc--sso-setup-authentik)
    - [4a. Create the Provider in Authentik](#4a-create-the-provider-in-authentik)
    - [4b. Create the Application in Authentik](#4b-create-the-application-in-authentik)
    - [4c. Find your Issuer URL](#4c-find-your-issuer-url)
    - [4d. Add to .env](#4d-add-to-env)
  - [5. Running multiple providers simultaneously](#5-running-multiple-providers-simultaneously)
  - [6. Whitelist vs. trust-your-IdP](#6-whitelist-vs-trust-your-idp)
  - [7. First-user / admin bootstrap](#7-first-user--admin-bootstrap)
  - [8. Full .env reference](#8-full-env-reference)

---

## 1. Environment file basics

Copy `.env.example` to `.env` and fill in the values you need. The file is never committed to git (`.gitignore` excludes it).

```bash
cp .env.example .env
nano .env          # or your editor of choice
```

At minimum you must set `SESSION_SECRET`. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 2. GitHub OAuth setup

### 2a. Create the OAuth App on GitHub

1. Go to **https://github.com/settings/developers**
2. Click **"New OAuth App"** (or open an existing one to edit)
3. Fill in the form:

   | Field | Value |
   |---|---|
   | Application name | `taskpapr` (or anything you like) |
   | Homepage URL | `https://yourdomain.com` |
   | Authorization callback URL | `https://yourdomain.com/auth/github/callback` |

4. Click **"Register application"**
5. On the next screen, note your **Client ID**
6. Click **"Generate a new client secret"** and note the **Client Secret** (you only see it once)

> **Multiple environments:** GitHub allows only one callback URL per OAuth app. For a second environment (e.g. local dev at `http://localhost:3033`), create a second OAuth App.

### 2b. Add to .env

```dotenv
GITHUB_CLIENT_ID=your_client_id_here
GITHUB_CLIENT_SECRET=your_client_secret_here
GITHUB_CALLBACK_URL=https://yourdomain.com/auth/github/callback
```

The login page will now show a **"Sign in with GitHub"** button.

### 2c. GitHub email requirements

GitHub OAuth only returns the user's email if at least one email address is set to **public** on their GitHub profile, or if the app requests the `user:email` scope (which taskpapr does). Users whose GitHub account has no accessible email will be rejected with a clear error message.

---

## 3. Google OAuth setup

### 3a. Create the OAuth Client in Google Cloud Console

1. Go to **https://console.cloud.google.com/apis/credentials**
2. Select (or create) a project
3. Click **"Create Credentials"** → **"OAuth 2.0 Client ID"**
4. Set the application type to **"Web application"**
5. Under **"Authorised redirect URIs"**, add:
   - Production: `https://yourdomain.com/auth/google/callback`
   - Local dev: `http://localhost:3033/auth/google/callback`
6. Click **"Create"**
7. Note the **Client ID** and **Client Secret**

### 3b. Enable the required API

taskpapr requests the `email` and `profile` scopes from Google. These are part of the standard Google People API. If prompted, enable **"Google People API"** for your project in the Cloud Console under **APIs & Services → Library**.

### 3c. Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**
2. Choose **"External"** (for users outside your organisation) or **"Internal"** (Google Workspace only)
3. Fill in the app name, support email, and developer contact
4. Under **"Scopes"**, add `email`, `profile`, and `openid`
5. If in **"Testing"** mode, add each user's Google email to the test users list (or publish the app to remove this restriction for External apps)

> **Internal vs External:** For a self-hosted install where all users have accounts in a single Google Workspace organisation, "Internal" is simpler — no consent screen publication needed.

### 3d. Add to .env

```dotenv
GOOGLE_CLIENT_ID=your_client_id_here
GOOGLE_CLIENT_SECRET=your_client_secret_here
GOOGLE_CALLBACK_URL=https://yourdomain.com/auth/google/callback
```

The login page will now show a **"Sign in with Google"** button.

---

## 4. OIDC / SSO setup (Authentik)

This works with any standards-compliant OIDC provider. The steps below are specific to **Authentik**.

### 4a. Create the Provider in Authentik

1. In your Authentik admin UI, go to **Applications → Providers**
2. Click **"Create"** → select **"OAuth2/OpenID Connect Provider"**
3. Fill in the form:

   | Field | Value |
   |---|---|
   | Name | `taskpapr-dev` |
   | Authorization flow | Your standard login flow (e.g. `default-authentication-flow`) |
   | Client type | **Confidential** |
   | Redirect URIs/Origins | `https://yourdomain.com/auth/oidc/callback` |

4. Under **"Advanced protocol settings"**, ensure these scopes are available:
   - `openid`
   - `email`
   - `profile`

5. Click **"Finish"**
6. Note the **Client ID** and **Client Secret** from the provider detail page

### 4b. Create the Application in Authentik

1. Go to **Applications → Applications**
2. Click **"Create"**
3. Fill in:

   | Field | Value |
   |---|---|
   | Name | `taskpapr-dev` |
   | Slug | `taskpapr-dev` |
   | Provider | Select the provider you just created |

4. Optionally, under **"Policy / Group / User Bindings"**, bind a group to restrict which Authentik users can access taskpapr

5. Click **"Create"**

### 4c. Find your Issuer URL

The OIDC issuer URL for Authentik follows this pattern:

```
https://<your-authentik-domain>/application/o/<application-slug>/
```

For example, if your Authentik is at `auth.example.com` and the slug is `taskpapr-dev`:

```
https://auth.example.com/application/o/taskpapr-dev/
```

You can verify this works by visiting:
```
https://auth.example.com/application/o/taskpapr-dev/.well-known/openid-configuration
```

It should return a JSON document describing the OIDC endpoints.

### 4d. Add to .env

```dotenv
OIDC_ISSUER=https://auth.example.com/application/o/taskpapr-dev/
OIDC_CLIENT_ID=your_oidc_client_id
OIDC_CLIENT_SECRET=your_oidc_client_secret
OIDC_CALLBACK_URL=https://yourdomain.com/auth/oidc/callback
OIDC_TRUST_IDP=true
```

The login page will now show a **"Sign in with SSO"** button.

---

## 5. Running multiple providers simultaneously

Simply set the environment variables for each provider you want to enable. All configured providers will show buttons on the login page. Omit (or leave blank) any provider you don't want.

Each user record is linked to the provider they used (`github`, `google`, or `oidc`). The same person logging in via two different providers will create two separate user records — this is intentional and avoids implicit account merging.

---

## 6. Whitelist vs. trust-your-IdP

By default, taskpapr uses an **invite whitelist**: a user's email must be in the whitelist table before they can log in. This is managed via the admin UI at `/admin`.

The `OIDC_TRUST_IDP` setting modifies this behaviour for OIDC logins only:

| `OIDC_TRUST_IDP` | Effect |
|---|---|
| `false` (default) | OIDC users must be on the whitelist, same as GitHub/Google users |
| `true` | Whitelist check is skipped for OIDC logins — anyone who can authenticate with your IdP is trusted |

**Recommendation:** Set `OIDC_TRUST_IDP=true` when using Authentik. Authentik is your own IdP and you already control who has accounts there. It's redundant to maintain a second whitelist in taskpapr.

For **Google OAuth**, the whitelist still applies (unless you're on a hosted SaaS deployment with open registration). This is intentional — unlike your own Authentik instance, Google accounts are not a closed universe you control.

---

## 7. First-user / admin bootstrap

The **very first user** to log in (regardless of provider) is automatically:
- Created without any whitelist check
- Granted admin privileges

This means you can deploy taskpapr with no whitelist entries, log in once, and then manage the whitelist from the `/admin` page.

> **Tip:** After first login, immediately go to `/admin` and add any other users' emails to the whitelist (if not using `OIDC_TRUST_IDP=true`).

---

## 8. Full .env reference

```dotenv
# ── Session ───────────────────────────────────────────────────
# Required. Generate with:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=change-me-to-a-long-random-string

# ── Server ────────────────────────────────────────────────────
PORT=3033
NODE_ENV=production

# ── Database ──────────────────────────────────────────────────
# Optional; defaults to ./data/taskpapr.db
DB_PATH=/opt/taskpapr/data/taskpapr.db

# ── GitHub OAuth ──────────────────────────────────────────────
# Omit or leave blank to disable GitHub login
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=https://yourdomain.com/auth/github/callback

# ── Google OAuth ──────────────────────────────────────────────
# Omit or leave blank to disable Google login
# Setup: https://console.cloud.google.com/apis/credentials
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=https://yourdomain.com/auth/google/callback

# ── OIDC / SSO ────────────────────────────────────────────────
# Omit or leave blank to disable SSO login
OIDC_ISSUER=https://auth.example.com/application/o/taskpapr-dev/
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
OIDC_CALLBACK_URL=https://yourdomain.com/auth/oidc/callback

# true  = anyone who can log in via your IdP is trusted (recommended for Authentik)
# false = OIDC users must also be on the whitelist
OIDC_TRUST_IDP=true
```
