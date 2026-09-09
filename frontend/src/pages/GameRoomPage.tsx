import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';

// ── Types ─────────────────────────────────────────────────────────────────────
interface Player {
  id: string; username: string; avatar: string;
  x: number; y: number; score: number; color: string;
  isMoving: boolean; trackPos: number; alive?: boolean;
}
interface Coin { id: string; x: number; y: number; type: string; collected: boolean; }
interface Question { id: string; question: string; options: string[]; correct: number; emoji: string; }
interface GameState {
  id: string; type: string; status: string; hostId: string;
  players: Record<string, Player>; coins: Coin[];
  question: Question | null; questionAnswers: Record<string, { answerIdx: number; isCorrect: boolean }>;
  wordTarget: string | null; timeLeft: number;
  winner: string | null; finalScores: { id: string; username: string; avatar: string; score: number; color: string; alive?: boolean }[];
  bombCarrier: string | null; bombTimer: number | null; eliminated: string[];
  gradeLevel: string;
}

// ── Helper: throttle socket emissions ──────────────────────────────────────────
function useThrottle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  const last = useRef(0);
  return useCallback(((...args: any[]) => {
    const now = Date.now();
    if (now - last.current >= ms) { last.current = now; fn(...args); }
  }) as T, [fn, ms]);
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function GameRoomPage() {
  const { gameId } = useParams<{ gameId: string }>();
  const { user } = useAuth();
  const { socket } = useSocket();
  const navigate = useNavigate();
  const [game, setGame] = useState<GameState | null>(null);
  const [error, setError] = useState('');
  const [wordInput, setWordInput] = useState('');
  const [bombExploded, setBombExploded] = useState(false);
  const [explodedCarrier, setExplodedCarrier] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<Set<string>>(new Set());
  const playerRef = useRef<Player | null>(null);

  // ── Socket listeners ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket || !gameId) return;
    socket.emit('game_join', { gameId });
    socket.emit('game_get_state', { gameId });

    const handlers: Record<string, (...args: any[]) => void> = {
      game_error: (msg: string) => setError(msg),
      game_players_update: ({ players }: { players: Record<string, Player> }) => {
        setGame(g => g ? { ...g, players } : g);
      },
      game_timer: ({ timeLeft }: { timeLeft: number }) => {
        setGame(g => g ? { ...g, timeLeft } : g);
      },
      game_coin_collected: ({ coinId, collectorId, newScore }: any) => {
        setGame(g => {
          if (!g) return g;
          const coins = g.coins.map(c => c.id === coinId ? { ...c, collected: true } : c);
          const players = { ...g.players };
          if (players[collectorId]) players[collectorId] = { ...players[collectorId], score: newScore };
          return { ...g, coins, players };
        });
      },
      game_coins_added: (fresh: Coin[]) => {
        setGame(g => g ? { ...g, coins: [...g.coins, ...fresh] } : g);
      },
      game_quiz_answered: ({ playerId, answerIdx, isCorrect, scores, trackPositions }: any) => {
        setGame(g => {
          if (!g) return g;
          const questionAnswers = { ...g.questionAnswers, [playerId]: { answerIdx, isCorrect } };
          const players = { ...g.players };
          Object.entries(scores).forEach(([id, score]) => {
            if (players[id]) players[id] = { ...players[id], score: score as number, trackPos: trackPositions[id] || 0 };
          });
          return { ...g, questionAnswers, players };
        });
      },
      game_word_typed: ({ playerId, scores, trackPositions }: any) => {
        setGame(g => {
          if (!g) return g;
          const players = { ...g.players };
          Object.entries(scores).forEach(([id, score]) => {
            if (players[id]) players[id] = { ...players[id], score: score as number, trackPos: trackPositions[id] || 0 };
          });
          return { ...g, players };
        });
      },
      game_new_word: ({ word }: { word: string }) => {
        setGame(g => g ? { ...g, wordTarget: word } : g);
        setWordInput('');
      },
      // Bomb Tag events
      bomb_tick: ({ bombTimer, bombCarrier }: { bombTimer: number; bombCarrier: string }) => {
        setGame(g => g ? { ...g, bombTimer, bombCarrier } : g);
      },
      bomb_exploded: ({ carrierId, eliminated }: { carrierId: string; eliminated: string[] }) => {
        setBombExploded(true);
        setExplodedCarrier(carrierId);
        setGame(g => g ? { ...g, eliminated, bombCarrier: null, bombTimer: null } : g);
        setTimeout(() => setBombExploded(false), 2000);
      },
      bomb_passed: ({ from, to, bombCarrier, bombTimer, scores }: any) => {
        setGame(g => {
          if (!g) return g;
          const players = { ...g.players };
          Object.entries(scores).forEach(([id, score]) => {
            if (players[id]) players[id] = { ...players[id], score: score as number };
          });
          return { ...g, bombCarrier, bombTimer, players };
        });
      },
      bomb_reassigned: ({ bombCarrier, bombTimer }: any) => {
        setGame(g => g ? { ...g, bombCarrier, bombTimer } : g);
      },
      game_state: (state: GameState) => { setGame(state); setError(''); },
    };

    Object.entries(handlers).forEach(([event, handler]) => socket.on(event, handler));
    return () => { Object.entries(handlers).forEach(([event, handler]) => socket.off(event, handler)); };
  }, [socket, gameId]);

  // ── Leave on unmount ──────────────────────────────────────────────────────
  useEffect(() => {
    return () => { socket?.emit('game_leave', { gameId }); };
  }, [socket, gameId]);

  // ── Movement (keyboard + touch) ───────────────────────────────────────────
  const emitMove = useThrottle((x: number, y: number, isMoving: boolean) => {
    socket?.emit('game_player_move', { gameId, x, y, isMoving });
  }, 30);

  useEffect(() => {
    if (!game || game.status !== 'playing' || game.type !== 'coin_rush' && game.type !== 'bomb_tag') return;
    const interval = setInterval(() => {
      if (!playerRef.current) return;
      let dx = 0, dy = 0;
      if (keysRef.current.has('ArrowLeft') || keysRef.current.has('a')) dx -= 5;
      if (keysRef.current.has('ArrowRight') || keysRef.current.has('d')) dx += 5;
      if (keysRef.current.has('ArrowUp') || keysRef.current.has('w')) dy -= 5;
      if (keysRef.current.has('ArrowDown') || keysRef.current.has('s')) dy += 5;
      if (dx === 0 && dy === 0) return;
      // Bomb carrier speed boost
      if (game.type === 'bomb_tag' && game.bombCarrier === user?.id) {
        dx *= 1.3; dy *= 1.3;
      }
      const newX = Math.max(24, Math.min(776, playerRef.current.x + dx));
      const newY = Math.max(24, Math.min(536, playerRef.current.y + dy));
      playerRef.current = { ...playerRef.current, x: newX, y: newY };
      emitMove(newX, newY, true);
    }, 50);
    return () => clearInterval(interval);
  }, [game?.status, game?.type, game?.bombCarrier, user?.id, emitMove, socket, gameId]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => keysRef.current.add(e.key);
    const up = (e: KeyboardEvent) => keysRef.current.delete(e.key);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  // ── Coin collection check ─────────────────────────────────────────────────
  useEffect(() => {
    if (!game || game.status !== 'playing' || game.type !== 'coin_rush' || !playerRef.current) return;
    const interval = setInterval(() => {
      if (!playerRef.current || !socket) return;
      const p = playerRef.current;
      game.coins.filter(c => !c.collected).forEach(coin => {
        if (Math.hypot(p.x - coin.x, p.y - coin.y) < 40) {
          socket.emit('game_collect_coin', { gameId, coinId: coin.id });
        }
      });
    }, 100);
    return () => clearInterval(interval);
  }, [game?.coins?.length, game?.status, socket, gameId]);

  // ── Bomb pass (click/tap near carrier in bomb_tag) ────────────────────────
  const handleBombPass = () => {
    socket?.emit('bomb_pass', { gameId });
  };

  // ── Update playerRef when game state changes ──────────────────────────────
  useEffect(() => {
    if (game && user?.id && game.players[user.id]) {
      playerRef.current = game.players[user.id];
    }
  }, [game, user?.id]);

  // ── Canvas rendering (Coin Rush + Bomb Tag) ───────────────────────────────
  useEffect(() => {
    if (!game || !canvasRef.current) return;
    if (game.type !== 'coin_rush' && game.type !== 'bomb_tag') return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let animId: number;

    const draw = () => {
      ctx.clearRect(0, 0, 800, 560);
      // Grid
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      for (let x = 0; x < 800; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 560); ctx.stroke(); }
      for (let y = 0; y < 560; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(800, y); ctx.stroke(); }

      if (game.type === 'coin_rush') {
        // Coins
        game.coins.filter(c => !c.collected).forEach(coin => {
          const emoji = coin.type === 'gem' ? '💎' : coin.type === 'star' ? '⭐' : '🪙';
          ctx.font = '24px serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(emoji, coin.x, coin.y);
        });
      }

      if (game.type === 'bomb_tag') {
        // Bomb carrier glow
        if (game.bombCarrier && game.players[game.bombCarrier]) {
          const bp = game.players[game.bombCarrier];
          ctx.beginPath();
          ctx.arc(bp.x, bp.y, 30, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, ${game.bombTimer && game.bombTimer <= 3 ? 0 : 100}, 0, ${0.3 + (game.bombTimer && game.bombTimer <= 3 ? 0.3 * Math.sin(Date.now() / 100) : 0)})`;
          ctx.fill();
        }
      }

      // Players
      Object.values(game.players).forEach(p => {
        if (game.type === 'bomb_tag' && !p.alive) {
          // Dead player - ghost
          ctx.globalAlpha = 0.3;
          ctx.font = '28px serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('💀', p.x, p.y);
          ctx.globalAlpha = 1;
          return;
        }
        // Player circle
        ctx.beginPath();
        ctx.arc(p.x, p.y, 18, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.strokeStyle = p.id === user?.id ? '#fff' : 'rgba(255,255,255,0.3)';
        ctx.lineWidth = p.id === user?.id ? 3 : 1;
        ctx.stroke();
        // Avatar
        ctx.font = '20px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.avatar, p.x, p.y);
        // Name tag
        ctx.font = '10px Nunito, sans-serif';
        ctx.fillStyle = '#fff';
        ctx.fillText(p.username, p.x, p.y + 26);
        // Bomb indicator
        if (game.type === 'bomb_tag' && game.bombCarrier === p.id) {
          ctx.font = '18px serif';
          ctx.fillText('💣', p.x + 16, p.y - 16);
        }
      });

      animId = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(animId);
  }, [game?.type, game?.coins, game?.players, game?.bombCarrier, game?.bombTimer, user?.id]);

  // ── Touch movement for mobile ─────────────────────────────────────────────
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStart.current || !playerRef.current) return;
    const dx = (e.touches[0].clientX - touchStart.current.x) * 2;
    const dy = (e.touches[0].clientY - touchStart.current.y) * 2;
    const newX = Math.max(24, Math.min(776, playerRef.current.x + dx));
    const newY = Math.max(24, Math.min(536, playerRef.current.y + dy));
    playerRef.current = { ...playerRef.current, x: newX, y: newY };
    emitMove(newX, newY, true);
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  // ── Word Blitz submit ─────────────────────────────────────────────────────
  const submitWord = () => {
    if (!wordInput.trim()) return;
    socket?.emit('game_word_submit', { gameId, word: wordInput.trim() });
    setWordInput('');
  };

  // ── Start game (host only) ────────────────────────────────────────────────
  const startGame = () => socket?.emit('game_start', { gameId });
  const leaveGame = () => { socket?.emit('game_leave', { gameId }); navigate('/games'); };

  // ── Loading / Error states ────────────────────────────────────────────────
  if (error) return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="text-center">
        <p className="text-red-400 text-xl mb-4">{error}</p>
        <button onClick={() => navigate('/games')} className="px-6 py-2 bg-purple-600 text-white rounded-xl">Back to Games</button>
      </div>
    </div>
  );
  if (!game) return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center">
      <div className="text-white text-xl animate-pulse">Loading game...</div>
    </div>
  );

  const me = game.players[user?.id || ''];
  const isHost = game.hostId === user?.id;
  const sorted = Object.values(game.players).sort((a, b) => b.score - a.score);
  const hasBomb = game.type === 'bomb_tag' && game.bombCarrier === user?.id;

  // ── FINISHED SCREEN ──────────────────────────────────────────────────────
  if (game.status === 'finished') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 to-purple-900 flex items-center justify-center p-4">
        <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          className="bg-gray-800/90 backdrop-blur rounded-3xl p-8 max-w-md w-full text-center">
          <h1 className="text-4xl mb-2">🏆</h1>
          <h2 className="text-2xl font-bold text-white mb-1">
            {game.winner ? game.players[game.winner]?.username : 'No winner'} wins!
          </h2>
          <p className="text-purple-300 mb-6">+15 Friend Points 🎉</p>
          <div className="space-y-2 mb-6">
            {game.finalScores?.map((p, i) => (
              <div key={p.id} className={`flex items-center gap-3 p-3 rounded-xl ${i === 0 ? 'bg-yellow-500/20 border border-yellow-500/30' : 'bg-gray-700/50'}`}>
                <span className="text-lg font-bold text-white w-8">{i + 1}</span>
                <span className="text-2xl">{p.avatar}</span>
                <span className="flex-1 text-white font-medium text-left">{p.username}</span>
                <span className="text-white font-bold">{p.score}</span>
                {game.type === 'bomb_tag' && (
                  <span className={`text-sm ${p.alive ? 'text-green-400' : 'text-red-400'}`}>
                    {p.alive ? '✅' : '💀'}
                  </span>
                )}
              </div>
            ))}
          </div>
          <button onClick={leaveGame} className="w-full py-3 bg-purple-600 text-white rounded-xl font-bold hover:bg-purple-500">
            Back to Games
          </button>
        </motion.div>
      </div>
    );
  }

  // ── LOBBY SCREEN ─────────────────────────────────────────────────────────
  if (game.status === 'lobby') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 to-purple-900 flex items-center justify-center p-4">
        <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }}
          className="bg-gray-800/90 backdrop-blur rounded-3xl p-6 max-w-md w-full">
          <h1 className="text-2xl font-bold text-white text-center mb-1">
            {game.type === 'coin_rush' ? '🪙' : game.type === 'quiz_duel' ? '🧠' : game.type === 'trivia' ? '📚' : game.type === 'word_blitz' ? '⌨️' : '💣'} Lobby
          </h1>
          <p className="text-purple-300 text-center text-sm mb-4">Share this room code with friends!</p>
          <div className="bg-gray-900 rounded-xl p-3 text-center mb-4">
            <span className="text-3xl font-mono text-purple-300 tracking-wider">{gameId?.slice(0, 8)}</span>
          </div>
          <div className="space-y-2 mb-6">
            {Object.values(game.players).map(p => (
              <div key={p.id} className="flex items-center gap-3 bg-gray-700/50 p-3 rounded-xl">
                <span className="text-2xl">{p.avatar}</span>
                <span className="text-white font-medium flex-1">{p.username}</span>
                {p.id === game.hostId && <span className="text-xs bg-purple-600 text-white px-2 py-0.5 rounded-full">Host</span>}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={leaveGame} className="flex-1 py-3 bg-gray-700 text-gray-300 rounded-xl hover:bg-gray-600">Leave</button>
            {isHost && (
              <button onClick={startGame} disabled={Object.keys(game.players).length < 2}
                className="flex-1 py-3 bg-green-600 text-white rounded-xl font-bold hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed">
                Start ({Object.keys(game.players).length}/8)
              </button>
            )}
          </div>
        </motion.div>
      </div>
    );
  }

  // ── PLAYING SCREEN ───────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      {/* Top Bar */}
      <div className="bg-gray-800/90 backdrop-blur px-4 py-2 flex items-center gap-3 z-10">
        <button onClick={leaveGame} className="text-gray-400 hover:text-white">✕</button>
        <div className="flex-1 text-center">
          <span className="text-white font-bold text-sm">
            ⏱️ {game.type === 'bomb_tag' ? Math.ceil(game.timeLeft || 0) : game.timeLeft !== undefined ? Math.ceil(game.timeLeft) : ''}
          </span>
          {game.type === 'bomb_tag' && game.bombTimer !== null && game.bombTimer !== undefined && (
            <span className={`ml-3 font-bold ${game.bombTimer <= 3 ? 'text-red-400 animate-pulse' : 'text-orange-400'}`}>
              💣 {game.bombTimer}s
            </span>
          )}
        </div>
        <div className="text-right">
          <span className="text-yellow-400 font-bold text-sm">⭐ {me?.score || 0}</span>
        </div>
      </div>

      {/* Scoreboard strip */}
      <div className="bg-gray-800/50 px-4 py-1 flex gap-3 overflow-x-auto text-xs">
        {sorted.map((p, i) => (
          <div key={p.id} className={`flex items-center gap-1 shrink-0 ${p.id === user?.id ? 'text-white font-bold' : 'text-gray-400'}`}>
            <span>{p.avatar}</span>
            <span>{p.score}</span>
            {game.type === 'bomb_tag' && game.bombCarrier === p.id && <span>💣</span>}
            {game.type === 'bomb_tag' && !p.alive && <span>💀</span>}
          </div>
        ))}
      </div>

      {/* Bomb exploded overlay */}
      <AnimatePresence>
        {bombExploded && (
          <motion.div initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
            <div className="text-center">
              <div className="text-8xl animate-bounce">💥</div>
              <div className="text-white text-2xl font-bold mt-2">
                {game.players[explodedCarrier]?.username || 'Someone'} got blown up!
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Coin Rush / Bomb Tag Canvas ─────────────────────────────────── */}
      {(game.type === 'coin_rush' || game.type === 'bomb_tag') && (
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="relative">
            <canvas
              ref={canvasRef} width={800} height={560}
              className="bg-gray-950 rounded-2xl border border-gray-700 max-w-full"
              style={{ maxWidth: '100%', touchAction: 'none' }}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
            />
            {game.type === 'bomb_tag' && hasBomb && (
              <motion.button whileTap={{ scale: 0.9 }} onClick={handleBombPass}
                className="absolute bottom-4 left-1/2 -translate-x-1/2 px-6 py-3 bg-red-600 text-white rounded-xl font-bold text-lg shadow-lg shadow-red-600/30 animate-pulse">
                💣 PASS BOMB!
              </motion.button>
            )}
          </div>
        </div>
      )}

      {/* ── Quiz / Trivia ───────────────────────────────────────────────── */}
      {(game.type === 'quiz_duel' || game.type === 'trivia') && game.question && (
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <div className="text-4xl mb-3">{game.question.emoji}</div>
          <h2 className="text-white text-xl font-bold text-center mb-6 max-w-lg">{game.question.question}</h2>
          <div className="grid grid-cols-2 gap-3 max-w-lg w-full">
            {game.question!.options.map((opt, i) => {
              const q = game.question!;
              const answered = game.questionAnswers[user?.id || ''] !== undefined;
              const isCorrect = q.correct === i;
              const myAnswer = game.questionAnswers[user?.id || '']?.answerIdx;
              let bg = 'bg-gray-700 hover:bg-gray-600 text-white';
              if (answered) {
                if (isCorrect) bg = 'bg-green-600 text-white';
                else if (myAnswer === i) bg = 'bg-red-600 text-white';
                else bg = 'bg-gray-800 text-gray-500';
              }
              return (
                <button key={i} onClick={() => !answered && socket?.emit('game_quiz_answer', { gameId, answerIdx: i })}
                  disabled={answered}
                  className={`p-4 rounded-xl font-medium transition-colors ${bg}`}>
                  {opt}
                </button>
              );
            })}
          </div>
          {/* Progress tracks */}
          <div className="mt-6 w-full max-w-lg space-y-2">
            {sorted.map(p => (
              <div key={p.id} className="flex items-center gap-2">
                <span className="text-sm w-6 text-center">{p.avatar}</span>
                <div className="flex-1 h-3 bg-gray-800 rounded-full overflow-hidden">
                  <motion.div className="h-full rounded-full" style={{ background: p.color }}
                    animate={{ width: `${p.trackPos || 0}%` }} transition={{ duration: 0.3 }} />
                </div>
                <span className="text-xs text-gray-400 w-8 text-right">{p.score}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Word Blitz ──────────────────────────────────────────────────── */}
      {game.type === 'word_blitz' && (
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <h2 className="text-purple-300 text-sm mb-2">Type this word:</h2>
          <div className="text-5xl font-bold text-white mb-8 tracking-wider">{game.wordTarget}</div>
          <div className="w-full max-w-md flex gap-2">
            <input
              value={wordInput} onChange={e => setWordInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submitWord()}
              placeholder="Type the word..."
              className="flex-1 px-4 py-3 bg-gray-800 text-white rounded-xl border border-gray-600 focus:border-purple-500 focus:outline-none text-lg"
              autoFocus
            />
            <button onClick={submitWord}
              className="px-6 py-3 bg-green-600 text-white rounded-xl font-bold hover:bg-green-500">
              ✓
            </button>
          </div>
          {/* Progress tracks */}
          <div className="mt-6 w-full max-w-md space-y-2">
            {sorted.map(p => (
              <div key={p.id} className="flex items-center gap-2">
                <span className="text-sm w-6 text-center">{p.avatar}</span>
                <div className="flex-1 h-3 bg-gray-800 rounded-full overflow-hidden">
                  <motion.div className="h-full rounded-full" style={{ background: p.color }}
                    animate={{ width: `${p.trackPos || 0}%` }} transition={{ duration: 0.3 }} />
                </div>
                <span className="text-xs text-gray-400 w-8 text-right">{p.score}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
