import { useLayoutEffect, useEffect, useState, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { useAuth } from './contexts/AuthContext';
import { useSocket } from './contexts/SocketContext';
import LoadingScreen from './components/LoadingScreen';
import WelcomePage from './pages/WelcomePage';
import AuthPage from './pages/AuthPage';
import MainLayout from './pages/MainLayout';
import VideoCallModal from './components/VideoCallModal';
import InstallPrompt from './components/InstallPrompt';
import { requestNotificationPermission } from './lib/notifications';

// Lazy-load heavy pages — each becomes its own chunk, loaded on demand
const ChatsPage = lazy(() => import('./pages/ChatsPage'));
const ChatPage = lazy(() => import('./pages/ChatPage'));
const ContactsPage = lazy(() => import('./pages/ContactsPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const ShopPage = lazy(() => import('./pages/ShopPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const GamesPage = lazy(() => import('./pages/GamesPage'));
const GameRoomPage = lazy(() => import('./pages/GameRoomPage'));

const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || '';
const HEALTH_URL = BACKEND ? `${BACKEND}/api/health` : '/api/health';
const POLL_MS = 3000;

function useServerReady() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function ping() {
      try {
        const res = await fetch(HEALTH_URL, { method: 'GET' });
        if (!cancelled && res.ok) { setReady(true); return; }
      } catch {
        // server not yet up — keep polling
      }
      if (!cancelled) setTimeout(ping, POLL_MS);
    }

    ping();
    return () => { cancelled = true; };
  }, []);

  return ready;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <LoadingScreen awaitingServer />;
  if (!user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();

  useLayoutEffect(() => {
    if (!isLoading && user) {
      navigate('/chats', { replace: true });
    }
  }, [user, isLoading, navigate]);

  if (isLoading || user) return <LoadingScreen awaitingServer />;
  return <>{children}</>;
}

export default function App() {
  const serverReady = useServerReady();
  const { globalIncomingCall, clearGlobalIncomingCall } = useSocket();

  useEffect(() => {
    // Request permission on first click/tap anywhere — browsers require a user gesture
    const ask = () => { requestNotificationPermission(); window.removeEventListener('click', ask); };
    window.addEventListener('click', ask);
    // Also try immediately in case permission was already granted
    requestNotificationPermission();
    return () => window.removeEventListener('click', ask);
  }, []);

  if (!serverReady) return <LoadingScreen awaitingServer />;

  return (
    <>
      <InstallPrompt />
      {/* Global incoming call overlay — visible from any page */}
      <AnimatePresence>
        {globalIncomingCall && (
          <VideoCallModal
            incoming={globalIncomingCall}
            onClose={clearGlobalIncomingCall}
          />
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
      <Suspense fallback={<LoadingScreen />}>
      <Routes>
        <Route
          path="/"
          element={
            <PublicRoute>
              <WelcomePage />
            </PublicRoute>
          }
        />
        <Route
          path="/auth"
          element={
            <PublicRoute>
              <AuthPage />
            </PublicRoute>
          }
        />
        <Route
          path="/chat/:chatId"
          element={
            <ProtectedRoute>
              <ChatPage />
            </ProtectedRoute>
          }
        />
        <Route
          element={
            <ProtectedRoute>
              <MainLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/chats" element={<ChatsPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/shop" element={<ShopPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/games" element={<GamesPage />} />
        </Route>
        <Route
          path="/game/:gameId"
          element={
            <ProtectedRoute>
              <GameRoomPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </AnimatePresence>
    </>
  );
}
