import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createOAuthPkcePair,
  isGenericOAuthPkceEnabled,
  isValidOAuthPkceSession,
  isValidOAuthPkceVerifier
} from '../apps/backend/src/services/auth/providers/oauth.pkce.ts';

test('PKCE is disabled by default, enabled for GENERIC only', () => {
  assert.equal(isGenericOAuthPkceEnabled('GENERIC', {}), false);
  assert.equal(isGenericOAuthPkceEnabled('GENERIC', { POSTIZ_OAUTH_PKCE_ENABLED: 'false' }), false);
  assert.equal(isGenericOAuthPkceEnabled('GENERIC', { POSTIZ_OAUTH_PKCE_ENABLED: 'true' }), true);
  assert.equal(isGenericOAuthPkceEnabled('GOOGLE', { POSTIZ_OAUTH_PKCE_ENABLED: 'true' }), false);
  assert.equal(isGenericOAuthPkceEnabled('LOCAL', { POSTIZ_OAUTH_PKCE_ENABLED: 'true' }), false);
});

test('validates state, verifier and cookie binding together', () => {
  const verifier = createOAuthPkcePair().verifier;
  const state = 'login-' + 'a'.repeat(16);
  assert.equal(isValidOAuthPkceSession(state, state, verifier), true);
  assert.equal(isValidOAuthPkceSession(state, 'login-' + 'b'.repeat(16), verifier), false);
  assert.equal(isValidOAuthPkceSession(state, state, 'bad'), false);
  assert.equal(isValidOAuthPkceSession('', '', verifier), false);
  assert.equal(isValidOAuthPkceSession(undefined, state, verifier), false);
});

test('generates secure, unpredictable S256 PKCE pairs', () => {
  const seen = new Set();
  for (let i = 0; i < 24; i++) {
    const { verifier, challenge } = createOAuthPkcePair();
    assert.equal(isValidOAuthPkceVerifier(verifier), true);
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(challenge, createHash('sha256').update(verifier, 'ascii').digest('base64url'));
    assert.equal(seen.has(verifier), false);
    seen.add(verifier);
  }
});

test('rejects missing and malformed PKCE verifiers', () => {
  for (const value of [undefined, null, '', 'short', 'a'.repeat(129), 'a'.repeat(42), 'a'.repeat(43) + '!', {}, 123]) {
    assert.equal(isValidOAuthPkceVerifier(value), false);
  }
  assert.equal(isValidOAuthPkceVerifier('a'.repeat(43)), true);
});
