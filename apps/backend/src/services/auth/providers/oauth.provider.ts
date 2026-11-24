import {
  AuthProvider,
  AuthProviderAbstract,
} from '@gitroom/backend/services/auth/providers.interface';
import { isGenericOAuthPkceEnabled, isValidOAuthPkceVerifier } from './oauth.pkce';

@AuthProvider({ provider: 'GENERIC' })
export class OauthProvider extends AuthProviderAbstract {
  private getConfig() {
    const {
      POSTIZ_OAUTH_AUTH_URL,
      POSTIZ_OAUTH_CLIENT_ID,
      POSTIZ_OAUTH_CLIENT_SECRET,
      POSTIZ_OAUTH_TOKEN_URL,
      POSTIZ_OAUTH_USERINFO_URL,
      FRONTEND_URL,
    } = process.env;

    if (
      !POSTIZ_OAUTH_USERINFO_URL ||
      !POSTIZ_OAUTH_TOKEN_URL ||
      !POSTIZ_OAUTH_CLIENT_ID ||
      !POSTIZ_OAUTH_CLIENT_SECRET ||
      !POSTIZ_OAUTH_AUTH_URL ||
      !FRONTEND_URL
    ) {
      throw new Error('POSTIZ_OAUTH environment variables are not set');
    }

    return {
      authUrl: POSTIZ_OAUTH_AUTH_URL,
      clientId: POSTIZ_OAUTH_CLIENT_ID,
      clientSecret: POSTIZ_OAUTH_CLIENT_SECRET,
      tokenUrl: POSTIZ_OAUTH_TOKEN_URL,
      userInfoUrl: POSTIZ_OAUTH_USERINFO_URL,
      frontendUrl: FRONTEND_URL,
    };
  }

  generateLink(query?: { state?: string; codeChallenge?: string }): string {
    const { authUrl, clientId, frontendUrl } = this.getConfig();
    const params = new URLSearchParams({
      client_id: clientId,
      scope: 'openid profile email',
      response_type: 'code',
      state: query?.state || 'login',
      redirect_uri: `${frontendUrl}/settings`,
    });

    if (isGenericOAuthPkceEnabled('GENERIC')) {
      if (!query?.codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(query.codeChallenge)) {
        throw new Error('Generic OAuth PKCE challenge is required');
      }
      params.set('code_challenge', query.codeChallenge);
      params.set('code_challenge_method', 'S256');
    }

    return `${authUrl}?${params.toString()}`;
  }

  async getToken(code: string, _redirectUri?: string, codeVerifier?: string): Promise<string> {
    const { tokenUrl, clientId, clientSecret, frontendUrl } = this.getConfig();
    const pkceEnabled = isGenericOAuthPkceEnabled('GENERIC');
    if (pkceEnabled && !isValidOAuthPkceVerifier(codeVerifier)) {
      throw new Error('Generic OAuth PKCE verifier is missing or invalid');
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${frontendUrl}/settings`,
    });
    if (pkceEnabled) body.set('code_verifier', codeVerifier!);
    const response = await fetch(`${tokenUrl}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });

    if (!response.ok) {
      // OAuth errors can contain sensitive data; never include upstream bodies in logs.
      throw new Error('Generic OAuth token exchange failed');
    }

    const { access_token } = await response.json();
    if (typeof access_token !== 'string' || !access_token) {
      throw new Error('Generic OAuth token response invalid');
    }
    return access_token;
  }

  async getUser(access_token: string): Promise<{ email: string; id: string }> {
    const { userInfoUrl } = this.getConfig();
    const response = await fetch(`${userInfoUrl}`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error('Generic OAuth userinfo request failed');
    }

    const { email, sub: id, email_verified } = await response.json();
    if (typeof email !== 'string' || !email || typeof id !== 'string' || !id) {
      throw new Error('Generic OAuth userinfo response invalid');
    }
    if (isGenericOAuthPkceEnabled('GENERIC') && email_verified !== true) {
      throw new Error('Generic OAuth requires a verified email identity');
    }
    return { email, id };
  }
}
