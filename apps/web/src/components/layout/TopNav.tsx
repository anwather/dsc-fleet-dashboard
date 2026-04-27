import { NavLink } from 'react-router-dom';
import { Server, FileCode2, Grid3x3, ListChecks } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { cn } from '@/lib/utils';

const items = [
  { to: '/servers', label: 'Servers', icon: Server },
  { to: '/configs', label: 'Configs', icon: FileCode2 },
  { to: '/assignments', label: 'Assignments', icon: Grid3x3 },
  { to: '/jobs', label: 'Jobs', icon: ListChecks },
];

export function TopNav() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center gap-6">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded bg-primary text-primary-foreground grid place-items-center font-bold">
            D
          </div>
          <span className="font-semibold">DSC Fleet</span>
          <span className="text-xs text-muted-foreground hidden sm:inline">v3 dashboard</span>
        </div>
        <nav className="flex items-center gap-1">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent',
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
