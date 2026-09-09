import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const handler = (e: any) => { e.preventDefault(); setDeferredPrompt(e); setShow(true); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const install = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') setShow(false);
    setDeferredPrompt(null);
  };

  if (!show) return null;

  return (
    <AnimatePresence>
      <motion.div initial={{ y: 100, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 100, opacity: 0 }}
        className="fixed bottom-4 left-4 right-4 z-50">
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 flex items-center gap-3 shadow-xl max-w-md mx-auto">
          <span className="text-3xl">📱</span>
          <div className="flex-1">
            <p className="text-white font-bold text-sm">Install Friendnix</p>
            <p className="text-gray-400 text-xs">Add to home screen for the best experience!</p>
          </div>
          <button onClick={install} className="px-4 py-2 bg-purple-600 text-white rounded-xl text-sm font-bold">Install</button>
          <button onClick={() => setShow(false)} className="text-gray-500 text-lg">✕</button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
