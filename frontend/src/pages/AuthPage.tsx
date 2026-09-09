import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../contexts/AuthContext';
import toast from 'react-hot-toast';

export default function AuthPage() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) return toast.error('Fill in all fields');
    setLoading(true);
    const fn = isLogin ? login : register;
    const result = await fn(username.trim(), password.trim());
    setLoading(false);
    if (result.error) return toast.error(result.error);
    toast.success(isLogin ? 'Welcome back! 🎉' : 'Account created! 🎉');
    navigate('/chats');
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--fc-welcome)' }}>
      <motion.div initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
        className="bg-white rounded-3xl shadow-xl p-8 max-w-sm w-full">
        <div className="text-center mb-6">
          <div className="text-5xl mb-2">🐾</div>
          <h1 className="text-2xl font-bold text-gray-800">{isLogin ? 'Welcome Back!' : 'Join Friendnix'}</h1>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-600 mb-1 block">Username</label>
            <input value={username} onChange={e => setUsername(e.target.value)}
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-purple-500 transition-colors"
              placeholder="Enter username" autoComplete="username" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-600 mb-1 block">Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-purple-500 transition-colors"
              placeholder="Enter password" autoComplete={isLogin ? 'current-password' : 'new-password'} />
          </div>
          <button type="submit" disabled={loading}
            className="w-full py-3 rounded-xl font-bold text-white text-lg shadow-md transition-all disabled:opacity-50"
            style={{ background: 'var(--fc-btn)' }}>
            {loading ? 'Loading...' : isLogin ? 'Log In' : 'Sign Up'}
          </button>
        </form>
        <p className="text-center text-sm text-gray-500 mt-4">
          {isLogin ? "Don't have an account?" : "Already have an account?"}
          <button onClick={() => setIsLogin(!isLogin)} className="ml-1 font-bold text-purple-600">
            {isLogin ? 'Sign Up' : 'Log In'}
          </button>
        </p>
      </motion.div>
    </div>
  );
}
