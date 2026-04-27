import { Component, type ReactNode } from 'react';

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error('uncaught error', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-8">
          <div className="max-w-md text-center space-y-3">
            <h1 className="text-2xl font-semibold">Something broke.</h1>
            <p className="text-muted-foreground text-sm">
              The dashboard hit an unexpected error. Try reloading. If it keeps happening,
              check the browser console and the API logs.
            </p>
            <pre className="mt-4 text-left text-xs bg-muted p-3 rounded overflow-auto max-h-48">
              {this.state.error?.stack ?? this.state.error?.message ?? 'unknown error'}
            </pre>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 px-4 py-2 rounded-md bg-primary text-primary-foreground"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
