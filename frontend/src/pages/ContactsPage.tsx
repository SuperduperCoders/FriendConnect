import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';
import toast from 'react-hot-toast';

const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || '';

interface Contact { id: string; username: string; avatar: string; status: string; secretId: string; isTester?: boolean; }

export default function ContactsPage() {
  const { user, token } = useAuth();
  const { socket } = useSocket();
  const navigate = useNavigate();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [incoming, setIncoming] = useState<any[]>([]);
  const [pending, setPending] = useState<any[]>([]);
  const [addId, setAddId] = useState('');
  const [tab, setTab] = useState<'list' | 'add' | 'requests'>('list');

  useEffect(() => { fetchContacts(); }, []);
  useEffect(() => {
    if (!socket) return;
    socket.on('contact_request', () => { fetchContacts(); toast('👋 New friend request!'); });
    socket.on('contact_accepted', () => fetchContacts());
    socket.on('contacts_status', (statuses: any[]) => {
      setContacts(prev => prev.map(c => {
        const s = statuses.find((st: any) => st.userId === c.id);
        return s ? { ...c, status: s.status } : c;
      }));
    });
    return () => { socket.off('contact_request'); socket.off('contact_accepted'); socket.off('contacts_status'); };
  }, [socket]);

  const fetchContacts = async () => {
    try {
      const res = await fetch(`${BACKEND}/api/contacts`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) { const d = await res.json(); setContacts(d.contacts); setIncoming(d.incoming); setPending(d.pending); }
    } catch {}
  };

  const sendRequest = async () => {
    if (!addId.trim()) return;
    try {
      const res = await fetch(`${BACKEND}/api/contacts/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ secretId: addId.trim().toUpperCase() }),
      });
      const data = await res.json();
      if (data.error) return toast.error(data.error);
      toast.success(data.message);
      setAddId('');
      setTab('list');
    } catch { toast.error('Failed'); }
  };

  const acceptRequest = async (userId: string) => {
    try {
      const res = await fetch(`${BACKEND}/api/contacts/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json();
      if (data.token) { localStorage.setItem('fc_token', data.token); }
      fetchContacts();
      toast.success('Friend added! 🎉');
    } catch {}
  };

  const rejectRequest = async (userId: string) => {
    await fetch(`${BACKEND}/api/contacts/reject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId }),
    });
    fetchContacts();
  };

  const removeContact = async (userId: string) => {
    if (!confirm('Remove this contact?')) return;
    try {
      const res = await fetch(`${BACKEND}/api/contacts/${userId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.token) localStorage.setItem('fc_token', data.token);
      fetchContacts();
    } catch {}
  };

  const openChat = (contactId: string) => {
    const chatId = [user?.id, contactId].sort().join('_');
    navigate(`/chat/${chatId}`);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-2 bg-white border-b border-gray-100">
        <h1 className="text-2xl font-bold text-gray-800 mb-3">👥 Contacts</h1>
        <div className="flex gap-2">
          {[['list', 'My Friends'], ['add', 'Add'], ['requests', `Requests${incoming.length ? ` (${incoming.length})` : ''}`]].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key as any)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold ${tab === key ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === 'list' && (
          <div>
            <div className="px-4 py-3 bg-gray-50">
              <p className="text-xs text-gray-500">Your Secret ID: <span className="font-mono font-bold text-purple-600">{user?.secretId}</span></p>
            </div>
            {contacts.map(c => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3 border-b border-gray-50 hover:bg-gray-50">
                <div className="relative">
                  <span className="text-3xl">{c.avatar}</span>
                  <span className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-white ${c.status === 'online' ? 'bg-green-500' : 'bg-gray-300'}`} />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-1">
                    <span className="font-bold text-gray-800">{c.username}</span>
                    {c.isTester && <span className="tester-badge"><span>TESTER</span></span>}
                  </div>
                  <span className="text-xs text-gray-400">{c.status}</span>
                </div>
                <button onClick={() => openChat(c.id)} className="text-purple-600 text-sm font-bold">💬</button>
                <button onClick={() => removeContact(c.id)} className="text-red-400 text-sm">✕</button>
              </div>
            ))}
            {contacts.length === 0 && <p className="text-center py-16 text-gray-400">No friends yet</p>}
          </div>
        )}
        {tab === 'add' && (
          <div className="p-4">
            <div className="bg-purple-50 rounded-2xl p-4 mb-4">
              <p className="text-sm text-purple-700 font-medium">Enter a friend's Secret ID (like FC-ABCD-1234) to add them!</p>
            </div>
            <div className="flex gap-2">
              <input value={addId} onChange={e => setAddId(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendRequest()}
                className="flex-1 px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-purple-500 uppercase tracking-wider font-mono"
                placeholder="FC-XXXX-XXXX" />
              <button onClick={sendRequest} className="px-6 py-3 bg-purple-600 text-white rounded-xl font-bold">Add</button>
            </div>
          </div>
        )}
        {tab === 'requests' && (
          <div>
            {incoming.map(r => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-3 border-b border-gray-50">
                <span className="text-3xl">{r.avatar}</span>
                <div className="flex-1">
                  <span className="font-bold text-gray-800">{r.username}</span>
                  <p className="text-xs text-gray-500">wants to be your friend!</p>
                </div>
                <button onClick={() => acceptRequest(r.id)} className="px-3 py-1.5 bg-green-500 text-white rounded-lg text-sm font-bold">✓</button>
                <button onClick={() => rejectRequest(r.id)} className="px-3 py-1.5 bg-gray-200 text-gray-600 rounded-lg text-sm">✕</button>
              </div>
            ))}
            {pending.length > 0 && (
              <div className="px-4 pt-4"><p className="text-xs text-gray-500 font-bold">Sent requests:</p></div>
            )}
            {pending.map(r => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-3 border-b border-gray-50">
                <span className="text-3xl">{r.avatar}</span>
                <span className="font-bold text-gray-800">{r.username}</span>
                <span className="text-xs text-gray-400 ml-auto">Pending...</span>
              </div>
            ))}
            {incoming.length === 0 && pending.length === 0 && (
              <p className="text-center py-16 text-gray-400">No pending requests</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
