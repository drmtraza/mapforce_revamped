import * as client from 'openid-client';
import type { IdentityProvider, LoginChecks, VerifiedIdentity } from './idp.ts';

export interface OidcOptions {
  issuerUrl: string;
  clientId: string;
  redirectUri: string;
  allowInsecureHttp: boolean;
}

/** Authorization-code + PKCE flow against any OIDC provider, as a public client. */
export function createOidcProvider(opts: OidcOptions): IdentityProvider {
  let configPromise: Promise<client.Configuration> | null = null;
  const getConfig = () => {
    configPromise ??= client
      .discovery(
        new URL(opts.issuerUrl),
        opts.clientId,
        undefined,
        client.None(),
        opts.allowInsecureHttp ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((err: unknown) => {
        configPromise = null;
        throw err;
      });
    return configPromise;
  };

  return {
    async createLogin() {
      const config = await getConfig();
      const checks: LoginChecks = {
        state: client.randomState(),
        nonce: client.randomNonce(),
        codeVerifier: client.randomPKCECodeVerifier(),
      };
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: opts.redirectUri,
        scope: 'openid email profile',
        code_challenge: await client.calculatePKCECodeChallenge(checks.codeVerifier),
        code_challenge_method: 'S256',
        state: checks.state,
        nonce: checks.nonce,
      });
      return { authorizationUrl: url.href, checks };
    },

    async completeLogin(callbackUrl, checks): Promise<VerifiedIdentity> {
      const config = await getConfig();
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error('ID token missing');
      const email = typeof claims.email === 'string' ? claims.email : null;
      if (!email) throw new Error('Identity provider did not return an email claim');
      const name = typeof claims.name === 'string' ? claims.name : null;
      return { issuer: claims.iss, subject: claims.sub, email, displayName: name };
    },
  };
}
