import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { useLanguage } from '../contexts/LanguageContext';
import toast from 'react-hot-toast';

const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || '';
const AVATARS = ['🐱','🐶','🐼','🦊','🐸','🦁','🐯','🐻','🐨','🐙','🦋','🐬','🦄','🐧','🦜','🐢','🦩','🦔','🐿️','🦘'];

export default function ProfilePage() {
  const { user, token, logout, refreshUser } = useAuth();
  const { theme, setTheme, themes } = useTheme();
  const { lang, setLang } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [avatar, setAvatar] = useState(user?.avatar || '🐱');
  const [dailyReward, setDailyReward] = useState<any>(null);

  useEffect(() => { fetchDailyReward(); }, []);

  const fetchDailyReward = async () => {
    try {
      const res = await fetch(`${BACKEND}/api/daily-reward`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setDailyReward(await res.json());
    } catch {}
  };

  const claimReward = async () => {
    try {
      const res = await fetch(`${BACKEND}/api/daily-reward`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.error) return toast.error(data.error);
      toast.success(data.message || `+${data.points} Friend Points! 🎉`);
      if (data.token) refreshUser(data.token);
      fetchDailyReward();
    } catch {}
  };

  const saveAvatar = async () => {
    try {
      const res = await fetch(`${BACKEND}/api/user/avatar`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ avatar }),
      });
      const data = await res.json();
      if (data.token) refreshUser(data.token);
      setEditing(false);
      toast.success('Avatar updated!');
    } catch {}
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Profile header */}
      <div className="px-4 pt-6 pb-4 text-center" style={{ background: 'var(--fc-header)' }}>
        <div className="relative inline-block">
          <span className="text-6xl">{avatar}</span>
          <button onClick={() => setEditing(!editing)}
            className="absolute -bottom-1 -right-1 w-7 h-7 bg-white rounded-full shadow flex items-center justify-center text-sm">✏️</button>
        </div>
        <h2 className="text-xl font-bold text-white mt-2">{user?.username}</h2>
        <p className="text-white/60 text-sm font-mono">{user?.secretId}</p>
        <div className="flex justify-center gap-4 mt-3">
          <div className="text-center">
            <p className="text-yellow-300 font-bold text-lg">⭐ {user?.friendPoints || 0}</p>
            <p className="text-white/50 text-xs">Points</p>
          </div>
        </div>
      </div>

      {/* Avatar picker */}
      {editing && (
        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
          className="bg-white border-b border-gray-100 px-4 py-3">
          <p className="text-xs font-bold text-gray-500 mb-2">Choose avatar:</p>
          <div className="flex flex-wrap gap-2">
            {AVATARS.map(a => (
              <button key={a} onClick={() => setAvatar(a)}
                className={`text-2xl p-1.5 rounded-xl ${avatar === a ? 'bg-purple-100 ring-2 ring-purple-500' : 'bg-gray-50'}`}>
                {a}
              </button>
            ))}
          </div>
          <button onClick={saveAvatar} className="mt-2 w-full py-2 bg-purple-600 text-white rounded-xl font-bold text-sm">Save</button>
        </motion.div>
      )}

      {/* Daily Reward */}
      {dailyReward && (
        <div className="px-4 py-3 border-b border-gray-100">
          <div className="bg-gradient-to-r from-yellow-50 to-orange-50 rounded-2xl p-4 flex items-center gap-3">
            <span className="text-3xl">🎁</span>
            <div className="flex-1">
              <p className="font-bold text-gray-800 text-sm">Daily Reward — Day {dailyReward.currentDay}/7</p>
              <p className="text-xs text-gray-500">Next: +{dailyReward.nextPoints} points</p>
            </div>
            {dailyReward.canClaim ? (
              <button onClick={claimReward} className="px-4 py-2 bg-yellow-500 text-white rounded-xl font-bold text-sm animate-pulse">Claim!</button>
            ) : (
              <span className="text-xs text-gray-400">✓ Claimed</span>
            )}
          </div>
        </div>
      )}

      {/* Settings */}
      <div className="px-4 py-3 space-y-3">
        <h3 className="text-xs font-bold text-gray-400 uppercase">Theme</h3>
        <div className="grid grid-cols-3 gap-2">
          {themes.map(t => (
            <button key={t.id} onClick={() => setTheme(t.id)}
              className={`p-2 rounded-xl text-center text-xs font-medium ${theme === t.id ? 'bg-purple-100 ring-2 ring-purple-500' : 'bg-gray-50'}`}>
              <span className="text-lg">{t.emoji}</span>
              <p className="mt-0.5">{t.name}</p>
            </button>
          ))}
        </div>

        <h3 className="text-xs font-bold text-gray-400 uppercase pt-2">Language</h3>
        <div className="flex flex-wrap gap-2">
          {[['en','🇬🇧 English'],['es','🇪🇸 Español'],['fr','🇫🇷 Français'],['de','🇩🇪 Deutsch'],['ja','🇯🇵 日本語'],['ko','🇰🇷 한국어'],['zh','🇨🇳 中文']].map(([code, label]) => (
            <button key={code} onClick={() => setLang(code as any)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium ${lang === code ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1" />
      <div className="px-4 pb-6 safe-area-bottom">
        <button onClick={logout}
          className="w-full py-3 bg-red-50 text-red-600 rounded-xl font-bold text-sm hover:bg-red-100 transition-colors">
          🚪 Log Out
        </button>
      </div>
    </div>
  );
}
