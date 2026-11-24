/**
 * Generic OAuth PKCE S256 support for the PostBro Social staging SSO pilot.
 * OFF by default. Never log or expose a verifier.
 */
import { createHash, randomBytes } from 'node:crypto';

const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export function isValidOAuthPkceVerifier(value: unknown): value is string {
  return typeof value === 'string' && VERIFIER_PATTERN.test(value);
}

export function isValidOAuthPkceSession(state: unknown, savedState: unknown, verifier: unknown): boolean {
  return typeof state === 'string' &&
    /^login-[A-Za-z0-9]{16}$/.test(state) &&
    state === savedState &&
    isValidOAuthPkceVerifier(verifier);
}

export function createOAuthPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

export function isGenericOAuthPkceEnabled(
  provider: string,
  env: { POSTIZ_OAUTH_PKCE_ENABLED?: string } = process.env
): boolean {
  return provider.toUpperCase() === 'GENERIC' && env.POSTIZ_OAUTH_PKCE_ENABLED === 'true';
}
