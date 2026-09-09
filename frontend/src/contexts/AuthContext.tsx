import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || '';

interface User {
  id: string; username: string; avatar: string; secretId: string;
  friendPoints: number; unlockedItems: string[]; contacts: string[];
  isAdmin?: boolean; isModerator?: boolean; isTester?: boolean;
  messageCount?: number; createdAt?: string;
}

interface AuthCtx {
  user: User | null; token: string | null; isLoading: boolean;
  login: (username: string, password: string) => Promise<{ error?: string }>;
  register: (username: string, password: string) => Promise<{ error?: string }>;
  logout: () => void;
  refreshUser: (token: string) => void;
}

const Ctx = createContext<AuthCtx>(null!);

export function useAuth() { return useContext(Ctx); }

function decodeUser(token: string): User | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return {
      id: payload.sub, username: payload.username, secretId: payload.secretId || '',
      avatar: payload.av || '🐱', friendPoints: payload.fp || 0,
      unlockedItems: payload.ui || [], contacts: payload.ct || [],
      isAdmin: payload.ia || false, isModerator: payload.im || false,
      createdAt: payload.createdAt,
    };
  } catch { return null; }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('fc_token'));
  const [user, setUser] = useState<User | null>(() => token ? decodeUser(token) : null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (token) {
      const u = decodeUser(token);
      setUser(u);
      localStorage.setItem('fc_token', token);
    } else {
      setUser(null);
      localStorage.removeItem('fc_token');
    }
    setIsLoading(false);
  }, [token]);

  const login = useCallback(async (username: string, password: string) => {
    try {
      const res = await fetch(`${BACKEND}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.error) return { error: data.error };
      setToken(data.token);
      return {};
    } catch { return { error: 'Connection failed' }; }
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    try {
      const res = await fetch(`${BACKEND}/api/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.error) return { error: data.error };
      setToken(data.token);
      return {};
    } catch { return { error: 'Connection failed' }; }
  }, []);

  const logout = useCallback(() => { setToken(null); setUser(null); localStorage.removeItem('fc_token'); }, []);
  const refreshUser = useCallback((newToken: string) => { setToken(newToken); }, []);

  return (
    <Ctx.Provider value={{ user, token, isLoading, login, register, logout, refreshUser }}>
      {children}
    </Ctx.Provider>
  );
}
