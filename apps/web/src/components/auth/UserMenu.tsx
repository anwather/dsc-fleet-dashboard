import { useMsal } from '@azure/msal-react';
import { LogOut } from 'lucide-react';

export function UserMenu() {
  const { instance, accounts } = useMsal();
  const account = accounts[0];
  if (!account) return null;

  const display = account.name ?? account.username ?? 'Signed in';

  const onSignOut = () => {
    instance.logoutRedirect({
      postLogoutRedirectUri: window.location.origin,
    });
  };

  return (
    <div className="flex items-center gap-2">
      <span
        className="text-sm text-muted-foreground hidden sm:inline truncate max-w-[16rem]"
        title={account.username}
      >
        {display}
      </span>
      <button
        onClick={onSignOut}
        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
        title="Sign out"
      >
        <LogOut className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Sign out</span>
      </button>
    </div>
  );
}
