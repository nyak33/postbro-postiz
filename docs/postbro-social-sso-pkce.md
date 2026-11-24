# PB-SOCIAL-006B — Generic OAuth PKCE S256 foundation

Status: CODE REVIEW / DRAFT PR ONLY. **Disabled by default.** No staging/production configuration, providers, databases, posts, schedules or user accounts were modified.

## Purpose

Make Postiz's existing `GENERIC` OAuth login provider capable of the PKCE S256 authorization-code flow required by Supabase Auth's OAuth 2.1 server. This is the first application-code prerequisite for PostBro Social single login, **not functional SSO on its own**.

## Changes

- Opt-in environment flag `POSTIZ_OAUTH_PKCE_ENABLED=true` (default OFF). Only applies to `GENERIC` provider.
- Generate a cryptographically random PKCE verifier and SHA-256 challenge per login attempt.
- Send `code_challenge` and `code_challenge_method=S256` on the authorization request.
- Keep `code_verifier` in a short-lived (10-minute), host-only, Secure, HttpOnly, SameSite=None cookie, never in the authorize URL, JS storage or logs.
- Keep a separate short-lived host-only OAuth state cookie for PKCE sessions; validate state and verifier before any token exchange.
- Send `code_verifier` to the configured token endpoint only during the authorization-code exchange. Clear both PKCE cookies after the attempt.
- Reject missing state, invalid verifier, missing access token and unverified `GENERIC` email identity while the flag is enabled.
- Sanitize upstream OAuth token/userinfo errors so response bodies cannot enter exception logs.
- Preserve the existing LOCAL login and unflagged GENERIC OAuth behavior.

## Staging prerequisites / NOT DONE

1. Confirm a **dedicated non-production Supabase Auth OAuth 2.1 server**, enable the OAuth server and provide a genuine authorization UI with approval/denial and durable consent state. Do not use the existing production PostBro Core Supabase project without separate approval.
2. Register a confidential OAuth client for **Postiz Staging**, with its exact `<staging-frontend>/settings` redirect URI. Set HTTPS authorize/token/userinfo endpoints and client credentials via staging-only protected configuration (never repository / chat / terminal output).
3. First validate the flow on a disposable staging user with no existing Postiz LOCAL identity or connected social channel.
4. Only then opt in `POSTIZ_OAUTH_PKCE_ENABLED=true` on staging. This PR does not set it.
5. Preserve existing Postiz user records; test explicit safe account linking instead of matching identities by email.
6. Add PostBro Social session SSO and org mapping in separate PRs (006C–006E). A Postiz cookie **never** proves a valid PostBro session.
7. Manual and regression checks: browser cookies on same-origin API, cross-site SameSite behavior, login refresh/expiration, denied consent, OAuth code replay, concurrent login tabs, invalid callback, PKCE mismatch, legacy LOCAL login, existing drafts/schedules, tenant/org isolation.

## Tests

```sh
node --experimental-strip-types --test tests/postbro-oauth-pkce.test.mjs
```

This invokes Node's built-in test runner (no token/key/IdP required). The PR should also pass the existing full Postiz build. These tests cover helper invariants only: they are **not** an authenticated browser SSO test.

## Future refinements

- Concurrent browser login tabs can overwrite their host-only PKCE cookie; handle separate per-state server-side ephemeral records before a wider customer rollout if multi-tab support matters.
- The existing generic OAuth callback uses the pre-existing `/settings` fixed redirect URI. Do not change this to a new callback without a reviewed IdP-client registration and migration.
- Ensure OAuth provider-specific userinfo and email verification behavior matches the dedicated staging IdP; fail closed.
- Before production, audit all auth cookies and OAuth callback replay semantics, and gate the PostBro sidebar button behind its own dedicated config flag.
