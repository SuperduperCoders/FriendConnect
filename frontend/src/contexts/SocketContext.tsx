import { createContext, useContext, useEffect, useState, useRef, ReactNode, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './AuthContext';

const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || window.location.origin;

interface IncomingCall {
  callId: string; chatId: string; callerId: string;
  callerName: string; callerAvatar: string; isGroup: boolean;
}

interface SocketCtx {
  socket: Socket | null; isConnected: boolean;
  globalIncomingCall: IncomingCall | null; clearGlobalIncomingCall: () => void;
}

const Ctx = createContext<SocketCtx>(null!);
export function useSocket() { return useContext(Ctx); }

export function SocketProvider({ children }: { children: ReactNode }) {
  const { user, token, refreshUser } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [globalIncomingCall, setGlobalIncomingCall] = useState<IncomingCall | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!user || !token) {
      socketRef.current?.disconnect();
      setSocket(null);
      setIsConnected(false);
      return;
    }
    const s = io(BACKEND, { transports: ['websocket', 'polling'], auth: { token } });
    socketRef.current = s;
    setSocket(s);

    s.on('connect', () => {
      setIsConnected(true);
      s.emit('authenticate', user.id);
    });
    s.on('disconnect', () => setIsConnected(false));
    s.on('token_refresh', ({ token: t }) => { if (t) refreshUser(t); });
    s.on('incoming_call', (call: IncomingCall) => setGlobalIncomingCall(call));
    s.on('call_rejected', () => setGlobalIncomingCall(null));
    s.on('call_ended', () => setGlobalIncomingCall(null));

    return () => { s.disconnect(); socketRef.current = null; };
  }, [user?.id, token]);

  const clearGlobalIncomingCall = useCallback(() => setGlobalIncomingCall(null), []);

  return (
    <Ctx.Provider value={{ socket, isConnected, globalIncomingCall, clearGlobalIncomingCall }}>
      {children}
    </Ctx.Provider>
  );
}
