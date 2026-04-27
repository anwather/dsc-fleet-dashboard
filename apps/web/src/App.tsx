import { Routes, Route, Navigate } from 'react-router-dom';
import { TopNav } from './components/layout/TopNav';
import { ServersPage } from './pages/ServersPage';
import { ServerDetailPage } from './pages/ServerDetailPage';
import { ConfigsPage } from './pages/ConfigsPage';
import { ConfigEditorPage } from './pages/ConfigEditorPage';
import { AssignmentsPage } from './pages/AssignmentsPage';
import { JobsPage } from './pages/JobsPage';
import { WsTopicsRoot } from './hooks/useWebSocket';

export default function App() {
  return (
    <WsTopicsRoot>
      <div className="min-h-screen flex flex-col">
        <TopNav />
        <main className="flex-1 container py-6">
          <Routes>
            <Route path="/" element={<Navigate to="/servers" replace />} />
            <Route path="/servers" element={<ServersPage />} />
            <Route path="/servers/:id" element={<ServerDetailPage />} />
            <Route path="/configs" element={<ConfigsPage />} />
            <Route path="/configs/new" element={<ConfigEditorPage />} />
            <Route path="/configs/:id" element={<ConfigEditorPage />} />
            <Route path="/assignments" element={<AssignmentsPage />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route
              path="*"
              element={
                <div className="text-center py-16 text-muted-foreground">
                  Page not found.
                </div>
              }
            />
          </Routes>
        </main>
      </div>
    </WsTopicsRoot>
  );
}
