import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main id="main" className="auth-page">
      <div className="card auth-card">
        <h1>Mapforce</h1>
        <p className="muted">Evidence-backed account and buying-committee research.</p>
        {error ? (
          <p role="alert" className="notice notice-error">
            Sign-in did not complete. Please try again.
          </p>
        ) : null}
        {/* A full navigation, not a fetch: the API redirects to the identity provider. */}
        <a className="button button-primary" href="/api/v1/auth/login">
          Sign in with your organization
        </a>
      </div>
    </main>
  );
}
