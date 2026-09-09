import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';

const GAMES = [
  {
    id: 'coin_rush',
    name: 'Coin Rush',
    emoji: '🪙',
    description: 'Collect coins, stars, and gems! Highest score wins.',
    color: 'from-yellow-500 to-orange-500',
    players: '2-8',
    time: '60s',
  },
  {
    id: 'quiz_duel',
    name: 'Quiz Duel',
    emoji: '🧠',
    description: 'Race to 100 on the progress track by answering questions correctly!',
    color: 'from-purple-500 to-pink-500',
    players: '2-8',
    time: 'Per question',
  },
  {
    id: 'trivia',
    name: 'Trivia',
    emoji: '📚',
    description: 'Grade-based trivia questions. First to 100 wins!',
    color: 'from-blue-500 to-cyan-500',
    players: '2-8',
    time: 'Per question',
  },
  {
    id: 'word_blitz',
    name: 'Word Blitz',
    emoji: '⌨️',
    description: 'Type the word fastest! Each correct answer advances you.',
    color: 'from-green-500 to-emerald-500',
    players: '2-8',
    time: '90s',
  },
  {
    id: 'bomb_tag',
    name: 'Bomb Tag',
    emoji: '💣',
    description: 'You have the bomb! Pass it before it explodes! Last one standing wins.',
    color: 'from-red-500 to-rose-500',
    players: '2-8',
    time: '90s',
  },
];

export default function GamesPage() {
  const { user } = useAuth();
  const { socket } = useSocket();
  const navigate = useNavigate();
  const [creating, setCreating] = useState<string | null>(null);
  const [triviaGrade, setTriviaGrade] = useState<'elementary' | 'middle' | 'high'>('elementary');
  const [showGradeModal, setShowGradeModal] = useState(false);
  const [pendingGradeGame, setPendingGradeGame] = useState<string | null>(null);

  useEffect(() => {
    if (!socket) return;
    const handleCreated = ({ gameId }: { gameId: string }) => {
      setCreating(null);
      navigate(`/game/${gameId}`);
    };
    const handleError = (err: string) => {
      setCreating(null);
      alert(err);
    };
    socket.on('game_created', handleCreated);
    socket.on('game_error', handleError);
    return () => {
      socket.off('game_created', handleCreated);
      socket.off('game_error', handleError);
    };
  }, [socket, navigate]);

  const createGame = (type: string) => {
    if (!socket) return;
    if (type === 'trivia') {
      setPendingGradeGame(type);
      setShowGradeModal(true);
      return;
    }
    setCreating(type);
    socket.emit('game_create', { type });
  };

  const createTriviaWithGrade = () => {
    if (!socket || !pendingGradeGame) return;
    setCreating(pendingGradeGame);
    setShowGradeModal(false);
    socket.emit('game_create', { type: pendingGradeGame, gradeLevel: triviaGrade });
    setPendingGradeGame(null);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-pink-900 p-4 pb-24">
      <div className="max-w-lg mx-auto">
        <h1 className="text-3xl font-bold text-white text-center mb-2">🎮 Games</h1>
        <p className="text-purple-200 text-center mb-6">Challenge your friends!</p>

        <div className="space-y-3">
          {GAMES.map((game) => (
            <motion.button
              key={game.id}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => createGame(game.id)}
              disabled={creating !== null}
              className={`w-full bg-gradient-to-r ${game.color} rounded-2xl p-4 text-left text-white shadow-lg hover:shadow-xl transition-shadow disabled:opacity-50`}
            >
              <div className="flex items-center gap-3">
                <span className="text-4xl">{game.emoji}</span>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <h2 className="text-xl font-bold">{game.name}</h2>
                    {creating === game.id && (
                      <span className="text-sm animate-pulse">Creating...</span>
                    )}
                  </div>
                  <p className="text-sm opacity-90">{game.description}</p>
                  <div className="flex gap-3 mt-1 text-xs opacity-75">
                    <span>👥 {game.players}</span>
                    <span>⏱️ {game.time}</span>
                  </div>
                </div>
              </div>
            </motion.button>
          ))}
        </div>

        <div className="mt-6 bg-white/10 rounded-2xl p-4 text-center">
          <p className="text-purple-200 text-sm">
            🏆 Winner gets <span className="text-yellow-300 font-bold">+15 Friend Points</span>!
          </p>
        </div>
      </div>

      {/* Trivia Grade Selection Modal */}
      {showGradeModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-gray-900 rounded-2xl p-6 w-full max-w-sm"
          >
            <h3 className="text-xl font-bold text-white mb-4 text-center">📚 Choose Grade Level</h3>
            {(['elementary', 'middle', 'high'] as const).map((grade) => (
              <button
                key={grade}
                onClick={() => { setTriviaGrade(grade); }}
                className={`w-full mb-2 p-3 rounded-xl text-left transition-colors ${
                  triviaGrade === grade
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                <span className="font-bold capitalize">{grade}</span>
                <span className="text-sm opacity-70 ml-2">
                  {grade === 'elementary' ? 'simple questions' : grade === 'middle' ? 'medium difficulty' : 'hard questions'}
                </span>
              </button>
            ))}
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => { setShowGradeModal(false); setPendingGradeGame(null); }}
                className="flex-1 p-3 rounded-xl bg-gray-700 text-gray-300 hover:bg-gray-600"
              >
                Cancel
              </button>
              <button
                onClick={createTriviaWithGrade}
                className="flex-1 p-3 rounded-xl bg-purple-600 text-white hover:bg-purple-500 font-bold"
              >
                Start 🚀
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
