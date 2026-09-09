import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';

const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || '';

interface Chat {
  id: string; name: string; avatar: string; lastMessage: string;
  lastTime: string; unread: number; isGroup: boolean; online?: boolean;
}

export default function ChatsPage() {
  const { user, token } = useAuth();
  const { socket } = useSocket();
  const navigate = useNavigate();
  const [chats, setChats] = useState<Chat[]>([]);
  const [search, setSearch] = useState('');
  const fetchedOnce = useRef(false);
  const unreadRef = useRef<Record<string, number>>({});
  const [unreadMap, setUnreadMap] = useState<Record<string, number>>({});

  useEffect(() => {
    fetchChats();
    if (!socket) return;

    // Delta-update: when a new message arrives, move that chat to top & bump unread
    // Instead of re-fetching the entire chat list from the server
    const onNewMessage = (msg: any) => {
      setChats(prev => {
        const idx = prev.findIndex(c => c.id === msg.chatId);
        const content = msg.type === 'image' ? '📷 Photo' : (msg.content || '');
        if (idx >= 0) {
          // Chat exists — update in place, move to top
          const updated = { ...prev[idx], lastMessage: content, lastTime: 'now' };
          return [updated, ...prev.filter((_, i) => i !== idx)];
        }
        // Chat doesn't exist yet (first message in new DM) — refetch once
        fetchChats();
        return prev;
      });
      // Bump unread if not the sender
      if (msg.senderId !== user?.id) {
        unreadRef.current = { ...unreadRef.current, [msg.chatId]: (unreadRef.current[msg.chatId] || 0) + 1 };
        setUnreadMap({ ...unreadRef.current });
      }
    };

    socket.on('new_message', onNewMessage);
    socket.on('message_notification', onNewMessage);
    return () => {
      socket.off('new_message', onNewMessage);
      socket.off('message_notification', onNewMessage);
    };
  }, [socket, user?.id]);

  const fetchChats = async () => {
    if (fetchedOnce.current && chats.length > 0) return; // avoid redundant refetches
    fetchedOnce.current = true;
    try {
      const res = await fetch(`${BACKEND}/api/chats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setChats(data);
        // Reset unread counts on full fetch
        unreadRef.current = {};
        setUnreadMap({});
      }
    } catch {}
  };

  const filtered = chats.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-2 bg-white border-b border-gray-100">
        <h1 className="text-2xl font-bold text-gray-800 mb-3">💬 Chats</h1>
        <input value={search} onChange={e => setSearch(e.target.value)}
          className="w-full px-4 py-2.5 bg-gray-100 rounded-xl text-sm focus:ring-2 focus:ring-purple-500 outline-none"
          placeholder="🔍 Search chats..." />
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <div className="text-5xl mb-3">💬</div>
            <p className="font-medium">No chats yet</p>
            <p className="text-sm">Add a friend to start chatting!</p>
          </div>
        )}
        {filtered.map(chat => (
          <motion.button key={chat.id} whileTap={{ scale: 0.98 }}
            onClick={() => { unreadRef.current = { ...unreadRef.current, [chat.id]: 0 }; setUnreadMap({ ...unreadRef.current }); navigate(`/chat/${chat.id}`); }}
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left border-b border-gray-50">
            <div className="relative">
              <span className="text-3xl">{chat.avatar}</span>
              {chat.online && <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-white" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="font-bold text-gray-800 truncate">{chat.name}</span>
                <span className="text-xs text-gray-400 shrink-0">{chat.lastTime}</span>
              </div>
              <p className="text-sm text-gray-500 truncate">{chat.lastMessage || 'Start a conversation...'}</p>
            </div>
            {(unreadMap[chat.id] || 0) > 0 && (
              <span className="bg-purple-600 text-white text-xs font-bold px-2 py-0.5 rounded-full shrink-0">
                {unreadMap[chat.id]}
              </span>
            )}
          </motion.button>
        ))}
      </div>
    </div>
  );
}
