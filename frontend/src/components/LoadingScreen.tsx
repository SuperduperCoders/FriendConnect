import { motion } from 'framer-motion';

export default function LoadingScreen({ awaitingServer = false }: { awaitingServer?: boolean }) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: 'var(--fc-welcome)' }}>
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="text-center"
      >
        <div className="text-6xl mb-4">🐾</div>
        <h1 className="text-3xl font-bold text-white mb-2">Friendnix</h1>
        <p className="text-white/70 text-sm">
          {awaitingServer ? 'Connecting to server...' : 'Loading...'}
        </p>
        <div className="mt-6 flex gap-1 justify-center">
          {[0, 1, 2].map(i => (
            <motion.div
              key={i}
              className="w-2 h-2 bg-white rounded-full"
              animate={{ y: [0, -8, 0] }}
              transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.15 }}
            />
          ))}
        </div>
      </motion.div>
    </div>
  );
}
