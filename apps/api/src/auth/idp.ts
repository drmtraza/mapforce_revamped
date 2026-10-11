export interface LoginChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email: string;
  displayName: string | null;
}

/** Identity-provider adapter so Keycloak (local) and a production IdP are interchangeable. */
export interface IdentityProvider {
  createLogin(): Promise<{ authorizationUrl: string; checks: LoginChecks }>;
  completeLogin(callbackUrl: URL, checks: LoginChecks): Promise<VerifiedIdentity>;
}
