import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const TABS = [
  { path: '/chats', icon: '💬', label: 'Chats' },
  { path: '/contacts', icon: '👥', label: 'Contacts' },
  { path: '/games', icon: '🎮', label: 'Games' },
  { path: '/shop', icon: '🛍️', label: 'Shop' },
  { path: '/profile', icon: '👤', label: 'Profile' },
];

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();

  const active = TABS.find(t => location.pathname.startsWith(t.path))?.path || '/chats';

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <Outlet />
      </div>
      <nav className="bg-white border-t border-gray-200 safe-area-bottom flex">
        {TABS.map(tab => (
          <button key={tab.path} onClick={() => navigate(tab.path)}
            className={`flex-1 flex flex-col items-center py-2 text-xs transition-colors ${
              active === tab.path ? 'text-purple-600' : 'text-gray-400'
            }`}>
            <span className="text-xl mb-0.5">{tab.icon}</span>
            <span className="font-medium">{tab.label}</span>
          </button>
        ))}
        {user?.isAdmin && (
          <button onClick={() => navigate('/admin')}
            className={`flex-1 flex flex-col items-center py-2 text-xs transition-colors ${
              active === '/admin' ? 'text-purple-600' : 'text-gray-400'
            }`}>
            <span className="text-xl mb-0.5">⚙️</span>
            <span className="font-medium">Admin</span>
          </button>
        )}
      </nav>
    </div>
  );
}
