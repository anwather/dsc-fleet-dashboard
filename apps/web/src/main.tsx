import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { MsalProvider } from '@azure/msal-react';
import App from './App';
import { queryClient } from './lib/queryClient';
import { ToastProvider } from './components/ToastProvider';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { msalInstance } from './lib/msal';
import './index.css';

// MSAL must be initialised before any React tree mounts that uses it.
msalInstance.initialize().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <MsalProvider instance={msalInstance}>
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <ToastProvider>
                <App />
              </ToastProvider>
            </BrowserRouter>
          </QueryClientProvider>
        </MsalProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
});
