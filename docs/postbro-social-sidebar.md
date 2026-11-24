# PB-SOCIAL-006E: PostBro Social navigation launch

Status: draft PR, **disabled by default**. No server login, cookies, credentials, database or posts are modified.

## Behavior

- When `NEXT_PUBLIC_POSTBRO_SOCIAL_ENABLED=true` and `NEXT_PUBLIC_POSTBRO_SOCIAL_URL` is a valid HTTPS URL without credentials, query or fragment, a **PostBro Social** shortcut appears in the left menu for Postiz users with an organization.
- Clicking it navigates in the **same tab** to the configured PostBro Social dashboard. No access token, API key, org ID, post ID or other data is sent in the URL.
- If the flag or URL is absent/invalid, **no shortcut is displayed**.
- Other external sidebar links keep their existing new-tab behavior.
- This link does **not** bypass PostBro authentication. The PostBro destination must verify its own IdP session; until PB-SOCIAL-006C is completed, the destination may prompt for login.
- The UI icon and route are not permission enforcement: PostBro must enforce subscription entitlement, role and tenant isolation server-side.

## Staging-only configuration (later)

- Set `NEXT_PUBLIC_POSTBRO_SOCIAL_ENABLED=true` in a **staging frontend build**, never production without separate approval.
- Set `NEXT_PUBLIC_POSTBRO_SOCIAL_URL` to the exact PostBro staging dashboard URL, `https://...`.
- The variables are build-time public UI configuration, not secrets.
- Rebuild/redeploy staging frontend only after a separate staging rollout decision.
- When the SSO endpoint is operational, a logged-in Postiz user clicking the button should return to the correct PostBro client dashboard with no second credential login.

## Test cases

- Flag unset/false: button hidden.
- Missing URL, non-HTTPS, credentials in URL, query string or fragment: button hidden.
- Valid URL + enabled flag: button visible, same-tab navigation.
- Existing MenuItem external links: still open in new tabs.
- Existing Postiz Calendar, Agent, Analytics and Settings continue working.
- PostBro without valid session: it must challenge through shared IdP; a Postiz cookie must never provide access.
- Multiple users/organizations: PostBro grants access only to correct authorized workspace.

Related: PostBro design PR #36; Postiz PKCE PR #1.
