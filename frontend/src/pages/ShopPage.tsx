import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useAuth } from '../contexts/AuthContext';
import toast from 'react-hot-toast';

const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || '';

interface ShopItem {
  id: string; category: string; name: string; emoji: string; description: string; cost: number;
}

const CATEGORIES: Record<string, string> = {
  theme: '🎨 Themes', reactions: '😍 Reaction Packs', background: '🖼️ Group Backgrounds',
  badge: '🏅 Badges', call_bg: '📹 Call Backgrounds', call_frame: '✨ Call Frames',
};

export default function ShopPage() {
  const { user, token, refreshUser } = useAuth();
  const [items, setItems] = useState<ShopItem[]>([]);
  const [cat, setCat] = useState('theme');
  const [loading, setLoading] = useState('');

  useEffect(() => { fetchItems(); }, []);

  const fetchItems = async () => {
    try {
      const res = await fetch(`${BACKEND}/api/shop`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setItems(await res.json());
    } catch {}
  };

  const buy = async (itemId: string) => {
    setLoading(itemId);
    try {
      const res = await fetch(`${BACKEND}/api/shop/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ itemId }),
      });
      const data = await res.json();
      if (data.error) { toast.error(data.error); setLoading(''); return; }
      if (data.token) refreshUser(data.token);
      toast.success('Purchased! 🎉');
    } catch { toast.error('Failed'); }
    setLoading('');
  };

  const owned = (id: string) => user?.unlockedItems?.includes(id);
  const cats = [...new Set(items.map(i => i.category))];
  const filtered = items.filter(i => i.category === cat);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-2 bg-white border-b border-gray-100">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-2xl font-bold text-gray-800">🛍️ Shop</h1>
          <span className="bg-yellow-100 text-yellow-700 px-3 py-1 rounded-full text-sm font-bold">
            ⭐ {user?.friendPoints || 0}
          </span>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-2">
          {cats.map(c => (
            <button key={c} onClick={() => setCat(c)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap ${cat === c ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
              {CATEGORIES[c] || c}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="grid grid-cols-2 gap-3">
          {filtered.map(item => (
            <motion.div key={item.id} whileTap={{ scale: 0.97 }}
              className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
              <span className="text-3xl">{item.emoji}</span>
              <h3 className="font-bold text-gray-800 text-sm mt-2">{item.name}</h3>
              <p className="text-xs text-gray-500 mt-0.5">{item.description}</p>
              {owned(item.id) ? (
                <span className="inline-block mt-2 text-xs bg-green-100 text-green-600 px-2 py-1 rounded-full font-bold">✓ Owned</span>
              ) : (
                <button onClick={() => buy(item.id)} disabled={loading === item.id || (user?.friendPoints || 0) < item.cost}
                  className="mt-2 w-full py-1.5 bg-purple-600 text-white rounded-xl text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed">
                  {loading === item.id ? '...' : `⭐ ${item.cost}`}
                </button>
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
