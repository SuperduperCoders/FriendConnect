import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';

const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || '';

interface Message {
  id: string; chatId: string; senderId: string; senderName: string;
  senderAvatar: string; content: string; type: string; timestamp: string;
  reactions?: Record<string, string[]>; replyTo?: any;
  edited?: boolean; editedAt?: string; senderIsTester?: boolean;
}

const REACTION_EMOJIS = ['❤️', '😂', '😮', '😢', '🔥', '👍'];

export default function ChatPage() {
  const { chatId } = useParams<{ chatId: string }>();
  const { user, token } = useAuth();
  const { socket } = useSocket();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const [showReactions, setShowReactions] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const typingTimeout = useRef<any>(null);

  useEffect(() => {
    fetchMessages();
    socket?.emit('join_chat', chatId);
    return () => { socket?.emit('leave_chat', chatId); };
  }, [chatId, socket]);

  useEffect(() => {
    if (!socket) return;
    const onNew = (msg: Message) => {
      if (msg.chatId === chatId) setMessages(prev => [...prev, msg]);
    };
    const onDeleted = ({ messageId }: any) => {
      setMessages(prev => prev.filter(m => m.id !== messageId));
    };
    const onEdited = ({ messageId, content, editedAt }: any) => {
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, content, edited: true, editedAt } : m));
    };
    const onReaction = ({ messageId, reactions }: any) => {
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, reactions } : m));
    };
    const onTyping = ({ userId, isTyping: typing }: any) => {
      setTypingUsers(prev => {
        const s = new Set(prev);
        if (typing) s.add(userId); else s.delete(userId);
        return s;
      });
    };
    socket.on('new_message', onNew);
    socket.on('message_deleted', onDeleted);
    socket.on('message_edited', onEdited);
    socket.on('reaction_updated', onReaction);
    socket.on('user_typing', onTyping);
    return () => {
      socket.off('new_message', onNew);
      socket.off('message_deleted', onDeleted);
      socket.off('message_edited', onEdited);
      socket.off('reaction_updated', onReaction);
      socket.off('user_typing', onTyping);
    };
  }, [socket, chatId]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const fetchMessages = async () => {
    try {
      const res = await fetch(`${BACKEND}/api/messages/${chatId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setMessages(await res.json());
    } catch {}
  };

  const sendMessage = async () => {
    if (!input.trim()) return;
    const content = input.trim();
    const body: any = { content };
    if (replyTo) {
      body.replyTo = { id: replyTo.id, senderName: replyTo.senderName, content: replyTo.content, type: replyTo.type };
    }
    setInput('');
    setReplyTo(null);
    socket?.emit('typing', { chatId, isTyping: false });
    try {
      const res = await fetch(`${BACKEND}/api/messages/${chatId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        if (data.error) alert(data.error);
      }
    } catch {}
  };

  const startEdit = (msg: Message) => {
    if (msg.senderId !== user?.id || msg.type !== 'text') return;
    setEditingId(msg.id);
    setEditContent(msg.content);
  };

  const saveEdit = async () => {
    if (!editingId || !editContent.trim()) return;
    try {
      const res = await fetch(`${BACKEND}/api/messages/${chatId}/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: editContent.trim() }),
      });
      if (res.ok) {
        setMessages(prev => prev.map(m => m.id === editingId ? { ...m, content: editContent.trim(), edited: true } : m));
      }
    } catch {}
    setEditingId(null);
    setEditContent('');
  };

  const cancelEdit = () => { setEditingId(null); setEditContent(''); };

  const unsend = async (msgId: string) => {
    if (!confirm('Unsend this message?')) return;
    try {
      await fetch(`${BACKEND}/api/messages/${chatId}/${msgId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
    } catch {}
  };

  const addReaction = (messageId: string, emoji: string) => {
    socket?.emit('add_reaction', { chatId, messageId, emoji });
    setShowReactions(null);
  };

  const handleInput = (val: string) => {
    setInput(val);
    if (!typingTimeout.current) {
      socket?.emit('typing', { chatId, isTyping: true });
    }
    clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => {
      socket?.emit('typing', { chatId, isTyping: false });
      typingTimeout.current = null;
    }, 2000);
  };

  const groupBySender = (msgs: Message[]) => {
    return msgs.reduce<Message[][]>((groups, msg) => {
      const last = groups[groups.length - 1];
      if (last && last[0].senderId === msg.senderId) last.push(msg);
      else groups.push([msg]);
      return groups;
    }, []);
  };

  const groups = groupBySender(messages);
  const typingNames = Array.from(typingUsers).filter(id => id !== user?.id);

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Header */}
      <div className="bg-white px-4 py-3 flex items-center gap-3 border-b border-gray-100 shadow-sm">
        <button onClick={() => navigate(-1)} className="text-gray-500 hover:text-gray-700 text-xl">←</button>
        <div className="flex-1">
          <h2 className="font-bold text-gray-800">{chatId?.replace(user?.id || '', '').replace('_', '') || 'Chat'}</h2>
          {typingNames.length > 0 && (
            <p className="text-xs text-purple-500 animate-pulse">typing...</p>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-2 messages-container space-y-1">
        {groups.map((group, gi) => {
          const isMe = group[0].senderId === user?.id;
          return (
            <div key={gi} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} mb-2`}>
              {!isMe && (
                <div className="flex items-center gap-1.5 mb-1 ml-1">
                  <span className="text-sm">{group[0].senderAvatar}</span>
                  <span className="text-xs font-bold text-gray-600">{group[0].senderName}</span>
                  {group[0].senderIsTester && <span className="tester-badge"><span>TESTER</span></span>}
                </div>
              )}
              {group.map((msg, mi) => (
                <div key={msg.id} className="relative group max-w-[75%]"
                  onDoubleClick={() => msg.senderId === user?.id && startEdit(msg)}>
                  {/* Reply preview */}
                  {msg.replyTo && (
                    <div className="bg-white/50 border-l-2 border-purple-400 px-2 py-1 rounded-t-lg text-xs text-gray-500">
                      ↩ {msg.replyTo.senderName}: {msg.replyTo.content?.slice(0, 50)}
                    </div>
                  )}
                  <div className={`msg-bubble px-3 py-2 rounded-2xl ${
                    isMe ? 'bg-purple-600 text-white rounded-br-sm' : 'bg-white text-gray-800 rounded-bl-sm shadow-sm'
                  }`}>
                    {msg.type === 'image' ? (
                      <img src={msg.content} alt="photo" className="rounded-xl max-w-[250px]" />
                    ) : (
                      <>
                        {editingId === msg.id ? (
                          <div className="flex gap-1">
                            <input value={editContent} onChange={e => setEditContent(e.target.value)}
                              onKeyDown={e => e.key === 'Enter' && saveEdit()}
                              className="flex-1 bg-white/20 text-white rounded px-2 py-1 text-sm outline-none" autoFocus />
                            <button onClick={saveEdit} className="text-green-300 text-xs">✓</button>
                            <button onClick={cancelEdit} className="text-red-300 text-xs">✕</button>
                          </div>
                        ) : (
                          <p className="text-sm break-words">{msg.content}</p>
                        )}
                        <div className={`flex items-center gap-1 mt-0.5 ${isMe ? 'justify-end' : ''}`}>
                          <span className={`text-[10px] ${isMe ? 'text-purple-200' : 'text-gray-400'}`}>
                            {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                          {msg.edited && <span className={`text-[10px] ${isMe ? 'text-purple-200' : 'text-gray-400'}`}>(edited)</span>}
                          {isMe && mi === group.length - 1 && (
                            <button onClick={() => unsend(msg.id)} className="text-[10px] text-red-300 opacity-0 group-hover:opacity-100 ml-1">🗑</button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  {/* Reactions */}
                  {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                    <div className="flex gap-0.5 mt-0.5 flex-wrap">
                      {Object.entries(msg.reactions).map(([emoji, users]) => (
                        <button key={emoji} onClick={() => addReaction(msg.id, emoji)}
                          className={`reaction-pill-enter text-xs px-1.5 py-0.5 rounded-full border ${
                            users.includes(user?.id || '') ? 'bg-purple-100 border-purple-300' : 'bg-gray-100 border-gray-200'
                          }`}>
                          {emoji} {users.length}
                        </button>
                      ))}
                    </div>
                  )}
                  {/* Reaction picker trigger */}
                  <div className="absolute -bottom-1 right-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => setShowReactions(showReactions === msg.id ? null : msg.id)}
                      className="text-sm bg-white rounded-full shadow px-1.5 py-0.5 border">😊</button>
                  </div>
                  <AnimatePresence>
                    {showReactions === msg.id && (
                      <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }}
                        className="absolute bottom-8 right-0 bg-white rounded-full shadow-lg px-2 py-1 flex gap-1 z-10 border">
                        {REACTION_EMOJIS.map(e => (
                          <button key={e} onClick={() => addReaction(msg.id, e)}
                            className="text-lg hover:scale-125 transition-transform">{e}</button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))}
            </div>
          );
        })}
        <div ref={messagesEnd} />
      </div>

      {/* Reply preview */}
      {replyTo && (
        <div className="bg-purple-50 px-4 py-2 flex items-center gap-2 border-t border-purple-100">
          <span className="text-xs text-purple-600 flex-1">↩ Replying to {replyTo.senderName}: {replyTo.content?.slice(0, 40)}</span>
          <button onClick={() => setReplyTo(null)} className="text-purple-400">✕</button>
        </div>
      )}

      {/* Input */}
      <div className="bg-white px-3 py-2 border-t border-gray-100 safe-area-bottom flex items-center gap-2">
        <input value={input} onChange={e => handleInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendMessage())}
          className="flex-1 px-4 py-2.5 bg-gray-100 rounded-full text-sm focus:ring-2 focus:ring-purple-500 outline-none"
          placeholder="Type a message..." />
        <button onClick={sendMessage}
          className="w-10 h-10 rounded-full flex items-center justify-center text-white shadow-md"
          style={{ background: 'var(--fc-fab)' }}>
          ➤
        </button>
      </div>
    </div>
  );
}
