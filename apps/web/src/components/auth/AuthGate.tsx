import { useEffect, useState, type PropsWithChildren } from 'react';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import { loginRequest } from '@/lib/authConfig';

export function AuthGate({ children }: PropsWithChildren) {
  const { instance, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const [redirectHandled, setRedirectHandled] = useState(false);

  useEffect(() => {
    instance
      .handleRedirectPromise()
      .catch((err) => {
        console.error('msal handleRedirectPromise failed', err);
      })
      .finally(() => setRedirectHandled(true));
  }, [instance]);

  useEffect(() => {
    if (!redirectHandled) return;
    if (inProgress !== 'none') return;
    if (isAuthenticated) return;
    instance.loginRedirect(loginRequest).catch((err) => {
      console.error('msal loginRedirect failed', err);
    });
  }, [redirectHandled, inProgress, isAuthenticated, instance]);

  if (!redirectHandled || !isAuthenticated) {
    return (
      <div className="min-h-screen grid place-items-center text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <div className="text-sm">Signing you in…</div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
