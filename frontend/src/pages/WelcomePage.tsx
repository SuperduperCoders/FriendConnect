import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';

export default function WelcomePage() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center" style={{ background: 'var(--fc-welcome)' }}>
      <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.6 }}>
        <div className="text-8xl mb-6">🐾</div>
        <h1 className="text-5xl font-bold text-white mb-3">Friendnix</h1>
        <p className="text-white/80 text-lg mb-2">Connect with your friends</p>
        <p className="text-white/50 text-sm mb-8 max-w-xs mx-auto">
          Chat, play games, share moments, and earn Friend Points together!
        </p>
        <div className="space-y-3 max-w-xs mx-auto">
          <button onClick={() => navigate('/auth')}
            className="w-full py-3 bg-white text-purple-700 rounded-xl font-bold text-lg shadow-lg hover:shadow-xl transition-shadow">
            Get Started →
          </button>
          <p className="text-white/40 text-xs">It's free! No phone number needed.</p>
        </div>
      </motion.div>
      <div className="mt-12 grid grid-cols-3 gap-4 text-white/60 text-2xl">
        <motion.span animate={{ y: [0, -5, 0] }} transition={{ duration: 2, repeat: Infinity, delay: 0 }}>💬</motion.span>
        <motion.span animate={{ y: [0, -5, 0] }} transition={{ duration: 2, repeat: Infinity, delay: 0.3 }}>🎮</motion.span>
        <motion.span animate={{ y: [0, -5, 0] }} transition={{ duration: 2, repeat: Infinity, delay: 0.6 }}>🏆</motion.span>
      </div>
    </div>
  );
}
