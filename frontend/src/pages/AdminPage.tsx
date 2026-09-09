import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';
import toast from 'react-hot-toast';

const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || '';

export default function AdminPage() {
  const { user, token } = useAuth();
  const { socket } = useSocket();
  const [flags, setFlags] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [tab, setTab] = useState<'flags' | 'users' | 'pending'>('flags');
  const [pending, setPending] = useState<any[]>([]);

  useEffect(() => {
    fetchData();
    socket?.on('new_flag', (flag: any) => { setFlags(prev => [flag, ...prev]); toast('🚩 New flagged message!'); });
    return () => { socket?.off('new_flag'); };
  }, [socket]);

  const fetchData = async () => {
    try {
      const [f, u, p] = await Promise.all([
        fetch(`${BACKEND}/api/admin/flags`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${BACKEND}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${BACKEND}/api/admin/pending-actions`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (f.ok) setFlags(await f.json());
      if (u.ok) setUsers(await u.json());
      if (p.ok) setPending(await p.json());
    } catch {}
  };

  const banUser = async (userId: string) => {
    if (!confirm('Ban this user?')) return;
    await fetch(`${BACKEND}/api/admin/ban`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId }),
    });
    fetchData();
    toast.success('User banned');
  };

  const deleteFlag = async (flagId: string) => {
    await fetch(`${BACKEND}/api/admin/flags/${flagId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    setFlags(prev => prev.filter(f => f.id !== flagId));
  };

  if (!user?.isAdmin) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-400">⚠️ Admin access only</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-2 bg-white border-b border-gray-100">
        <h1 className="text-2xl font-bold text-gray-800 mb-3">⚙️ Admin Panel</h1>
        <div className="flex gap-2">
          {[['flags', `🚩 Flags (${flags.length})`], ['users', `👤 Users (${users.length})`], ['pending', `⏳ Pending (${pending.length})`]].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key as any)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold ${tab === key ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {tab === 'flags' && flags.map(f => (
          <div key={f.id} className="bg-red-50 rounded-xl p-3 border border-red-100">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-lg">{f.senderAvatar}</span>
              <span className="font-bold text-sm text-gray-800">{f.senderName}</span>
              <span className="text-xs text-gray-400 ml-auto">{new Date(f.timestamp).toLocaleString()}</span>
            </div>
            <p className="text-sm text-gray-700 mb-2">{f.content}</p>
            <div className="flex gap-2">
              <button onClick={() => banUser(f.senderId)} className="px-3 py-1 bg-red-500 text-white rounded-lg text-xs font-bold">Ban</button>
              <button onClick={() => deleteFlag(f.id)} className="px-3 py-1 bg-gray-200 text-gray-600 rounded-lg text-xs">Dismiss</button>
            </div>
          </div>
        ))}
        {tab === 'users' && users.map(u => (
          <div key={u.id} className="flex items-center gap-3 p-3 bg-white rounded-xl border border-gray-100">
            <span className="text-2xl">{u.avatar}</span>
            <div className="flex-1">
              <span className="font-bold text-sm">{u.username}</span>
              <p className="text-xs text-gray-400">{u.id.slice(0, 8)}... • ⭐ {u.friendPoints || 0}</p>
            </div>
            {u.banned && <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full">Banned</span>}
            {!u.banned && <button onClick={() => banUser(u.id)} className="text-xs text-red-500 font-bold">Ban</button>}
          </div>
        ))}
        {tab === 'pending' && pending.map(p => (
          <div key={p.id} className="p-3 bg-yellow-50 rounded-xl border border-yellow-100">
            <p className="text-sm text-gray-700">{p.description || JSON.stringify(p)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
