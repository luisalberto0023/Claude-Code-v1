import { useState, useEffect, useCallback, useRef } from 'react';
import GameBoard from '../components/GameBoard.jsx';
import { createInitialState, makeMove, applyCascade, applyVoid, skipTurn, getValidMoves } from '../game/gameLogic.js';
import { getAIMove, AI_TAUNTS } from '../game/aiPlayer.js';

const P_COLOR = ['', '#00f5ff', '#ff0055'];
const P_LABEL = ['', 'CYAN', 'CRIMSON'];

function PlayerPanel({ state, playerNum, isActive, aiThinking, activePowerUp, onPowerUp, surgeBonus, cascadeMode }) {
  const { scores, playerNames, powerUps } = state;
  const color = P_COLOR[playerNum];
  const pups = powerUps?.[playerNum];
  const name = playerNames[playerNum - 1] || `PLAYER ${playerNum}`;
  const total = state.totalBoxes;
  const score = scores[playerNum];
  const pct = total > 0 ? (score / total) * 100 : 0;

  return (
    <div style={{
      background: isActive ? `rgba(${playerNum === 1 ? '0,245,255' : '255,0,85'},0.05)` : 'rgba(10,10,31,0.6)',
      border: `1px solid ${isActive ? color : '#1a1a4a'}`,
      borderRadius: '6px',
      padding: '1.25rem',
      transition: 'all 0.3s',
      boxShadow: isActive ? `0 0 20px ${color}20` : 'none',
      animation: isActive ? `pulse-${playerNum === 1 ? 'cyan' : 'pink'} 2s ease infinite` : 'none',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
        <div>
          <div style={{ fontFamily: 'Orbitron', fontSize: '0.55rem', color: color, letterSpacing: '0.2em', marginBottom: '0.25rem' }}>
            {P_LABEL[playerNum]} UNIT
          </div>
          <div style={{ fontFamily: 'Orbitron', fontSize: '0.85rem', color: isActive ? color : '#c0c0ff', fontWeight: 700, letterSpacing: '0.05em' }}>
            {name}
          </div>
        </div>
        {isActive && !aiThinking && (
          <span className="badge" style={{ background: `${color}20`, color, border: `1px solid ${color}50`, fontSize: '0.5rem', animation: 'flicker 1.5s ease infinite' }}>
            YOUR TURN
          </span>
        )}
        {aiThinking && (
          <span className="badge badge-yellow" style={{ fontSize: '0.5rem', animation: 'flicker 0.8s ease infinite' }}>
            COMPUTING
          </span>
        )}
      </div>

      {/* Score */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
          <span style={{ fontSize: '0.65rem', color: '#404070', fontFamily: 'Orbitron', letterSpacing: '0.1em' }}>SECTORS</span>
          <span style={{ fontFamily: 'Orbitron', fontSize: '1.4rem', color, fontWeight: 900, lineHeight: 1 }}>{score}</span>
        </div>
        <div style={{ height: '3px', background: '#0f0f28', borderRadius: '2px', overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${pct}%`,
            background: color,
            boxShadow: `0 0 6px ${color}`,
            borderRadius: '2px',
            transition: 'width 0.4s ease',
          }} />
        </div>
        <div style={{ fontSize: '0.6rem', color: '#303060', marginTop: '0.3rem' }}>{score}/{total} sectors</div>
      </div>

      {/* Combos / status */}
      {isActive && state.comboCount > 1 && (
        <div style={{ marginBottom: '0.75rem' }}>
          <span className="badge badge-yellow" style={{ fontSize: '0.6rem' }}>
            🔥 x{state.comboCount} COMBO
          </span>
        </div>
      )}
      {isActive && surgeBonus && (
        <div style={{ marginBottom: '0.75rem' }}>
          <span className="badge badge-cyan" style={{ fontSize: '0.6rem' }}>⚡ SURGE ACTIVE — BONUS MOVE</span>
        </div>
      )}
      {isActive && cascadeMode && (
        <div style={{ marginBottom: '0.75rem' }}>
          <span className="badge badge-purple" style={{ fontSize: '0.6rem' }}>💥 CASCADE READY</span>
        </div>
      )}

      {/* Power-ups */}
      {pups && (
        <div>
          <div style={{ fontFamily: 'Orbitron', fontSize: '0.55rem', color: '#303060', letterSpacing: '0.15em', marginBottom: '0.6rem' }}>
            POWER-UPS
          </div>
          <div style={{ display: 'flex', flex: 'column', gap: '0.4rem', flexDirection: 'column' }}>
            {[
              { id: 'surge', icon: '⚡', label: 'SURGE', desc: 'Bonus move', charges: pups.surge, color: '#00f5ff' },
              { id: 'void', icon: '🌀', label: 'VOID', desc: 'Erase last', charges: pups.void, color: '#bf00ff' },
              { id: 'cascade', icon: '💥', label: 'CASCADE', desc: 'Chain claim', charges: pups.cascade, color: '#ffd700' },
            ].map(pu => {
              const isActive2 = activePowerUp === pu.id;
              const canUse = isActive && pu.charges > 0 && !activePowerUp && state.currentPlayer === playerNum;
              return (
                <button
                  key={pu.id}
                  onClick={() => canUse && onPowerUp(pu.id)}
                  disabled={!canUse}
                  style={{
                    background: isActive2 ? `${pu.color}18` : 'rgba(5,5,16,0.6)',
                    border: `1px solid ${isActive2 ? pu.color : pu.charges > 0 ? '#1e1e4a' : '#0f0f24'}`,
                    borderRadius: '3px',
                    padding: '0.45rem 0.6rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    cursor: canUse ? 'pointer' : 'default',
                    opacity: pu.charges === 0 ? 0.35 : 1,
                    boxShadow: isActive2 ? `0 0 10px ${pu.color}40` : 'none',
                    transition: 'all 0.2s',
                    width: '100%',
                  }}
                >
                  <span style={{ fontSize: '0.85rem' }}>{pu.icon}</span>
                  <div style={{ flex: 1, textAlign: 'left' }}>
                    <div style={{ fontFamily: 'Orbitron', fontSize: '0.5rem', color: isActive2 ? pu.color : '#8080c0', letterSpacing: '0.1em' }}>{pu.label}</div>
                    <div style={{ fontSize: '0.6rem', color: '#303060' }}>{pu.desc}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '3px' }}>
                    {Array.from({ length: 2 }, (_, i) => (
                      <div key={i} style={{ width: '6px', height: '6px', borderRadius: '50%', background: i < pu.charges ? pu.color : '#0f0f28', boxShadow: i < pu.charges ? `0 0 4px ${pu.color}` : 'none' }} />
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function TimerBar({ state, onTimeout }) {
  const [timeLeft, setTimeLeft] = useState(10);
  const lastPlayer = useRef(state.currentPlayer);
  const lastMove = useRef(state.moveCount);

  useEffect(() => {
    if (state.mode !== 'blitz' || state.status !== 'playing') return;
    if (state.currentPlayer !== lastPlayer.current || state.moveCount !== lastMove.current) {
      setTimeLeft(10);
      lastPlayer.current = state.currentPlayer;
      lastMove.current = state.moveCount;
    }
  }, [state.currentPlayer, state.moveCount, state.mode, state.status]);

  useEffect(() => {
    if (state.mode !== 'blitz' || state.status !== 'playing') return;
    const timer = setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1) { onTimeout(); return 10; }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [state.mode, state.status, state.currentPlayer, state.moveCount, onTimeout]);

  if (state.mode !== 'blitz') return null;

  const pct = (timeLeft / 10) * 100;
  const color = timeLeft <= 3 ? '#ff0055' : timeLeft <= 6 ? '#ffd700' : '#00f5ff';

  return (
    <div style={{ marginBottom: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
        <span style={{ fontFamily: 'Orbitron', fontSize: '0.6rem', color: '#404070', letterSpacing: '0.15em' }}>⏱ TURN TIMER</span>
        <span style={{ fontFamily: 'Orbitron', fontSize: '0.85rem', color, fontWeight: 700, animation: timeLeft <= 3 ? 'flicker 0.5s infinite' : 'none' }}>
          {String(timeLeft).padStart(2, '0')}
        </span>
      </div>
      <div style={{ height: '4px', background: '#0f0f28', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{
          height: '100%',
          width: `${pct}%`,
          background: `linear-gradient(90deg, ${color}, ${color}aa)`,
          boxShadow: `0 0 8px ${color}`,
          borderRadius: '2px',
          transition: 'width 0.9s linear, background 0.3s',
        }} />
      </div>
    </div>
  );
}

export default function GamePage({ config, onGameOver, onQuit }) {
  const [gameState, setGameState] = useState(() => createInitialState(config));
  const [aiThinking, setAIThinking] = useState(false);
  const [activePowerUp, setActivePowerUp] = useState(null);
  const [surgeBonus, setSurgeBonus] = useState(false);
  const [surgeConsumed, setSurgeConsumed] = useState(false);
  const [cascadeMode, setCascadeMode] = useState(false);
  const [voidMode, setVoidMode] = useState(false);
  const [aiTaunt, setAITaunt] = useState('');
  const [showTaunt, setShowTaunt] = useState(false);
  const [comboFlash, setComboFlash] = useState(null);

  const { vsAI, aiDifficulty } = config;
  const isBoardDisabled = aiThinking || voidMode || (vsAI && gameState.currentPlayer === 2) || gameState.status !== 'playing';

  const triggerTaunt = useCallback((type) => {
    const pool = AI_TAUNTS[type] || AI_TAUNTS.neutral;
    const msg = pool[Math.floor(Math.random() * pool.length)];
    setAITaunt(msg);
    setShowTaunt(true);
    setTimeout(() => setShowTaunt(false), 3000);
  }, []);

  const handleMove = useCallback((lineType, row, col) => {
    if (gameState.status !== 'playing') return;

    if (voidMode) {
      const newState = applyVoid(gameState);
      setVoidMode(false);
      setActivePowerUp(null);
      setGameState(newState);
      if (newState.status === 'finished') { setTimeout(() => onGameOver(newState), 600); }
      return;
    }

    let newState = makeMove(gameState, lineType, row, col);
    if (newState === gameState) return;

    const boxesClosed = newState.animatingBoxes.length;
    const stayedTurn = newState.currentPlayer === gameState.currentPlayer && newState.status === 'playing';

    if (boxesClosed > 1) {
      setComboFlash({ count: boxesClosed, player: gameState.currentPlayer });
      setTimeout(() => setComboFlash(null), 1200);
    }

    if (cascadeMode && boxesClosed > 0) {
      newState = applyCascade(newState);
      setCascadeMode(false);
      setActivePowerUp(null);
    }

    if (surgeBonus && !stayedTurn && !surgeConsumed) {
      setSurgeConsumed(true);
      setGameState({ ...newState, currentPlayer: gameState.currentPlayer });
      if (newState.status === 'finished') { setTimeout(() => onGameOver(newState), 600); }
      return;
    }

    if (surgeConsumed) {
      setSurgeBonus(false);
      setSurgeConsumed(false);
    }

    setGameState(newState);
    if (newState.status === 'finished') { setTimeout(() => onGameOver(newState), 600); }
  }, [gameState, voidMode, cascadeMode, surgeBonus, surgeConsumed, onGameOver]);

  const handlePowerUp = useCallback((id) => {
    if (activePowerUp === id) {
      setActivePowerUp(null);
      if (id === 'void') setVoidMode(false);
      if (id === 'cascade') setCascadeMode(false);
      if (id === 'surge') { setSurgeBonus(false); setSurgeConsumed(false); }
      return;
    }

    const player = gameState.currentPlayer;
    const charges = gameState.powerUps?.[player]?.[id] || 0;
    if (charges <= 0) return;

    setActivePowerUp(id);
    const newPowerUps = {
      ...gameState.powerUps,
      [player]: { ...gameState.powerUps[player], [id]: charges - 1 },
    };
    setGameState(s => ({ ...s, powerUps: newPowerUps }));

    if (id === 'surge') { setSurgeBonus(true); setSurgeConsumed(false); }
    if (id === 'void') setVoidMode(true);
    if (id === 'cascade') setCascadeMode(true);
  }, [activePowerUp, gameState]);

  const handleTimeout = useCallback(() => {
    if (vsAI && gameState.currentPlayer === 2) return;
    const newState = skipTurn(gameState);
    setGameState(newState);
    setSurgeBonus(false); setSurgeConsumed(false); setCascadeMode(false); setVoidMode(false); setActivePowerUp(null);
  }, [gameState, vsAI]);

  useEffect(() => {
    if (!vsAI || gameState.currentPlayer !== 2 || gameState.status !== 'playing') return;

    setAIThinking(true);
    const delay = 600 + Math.random() * 600;
    const timer = setTimeout(() => {
      const move = getAIMove(gameState, aiDifficulty);
      setAIThinking(false);
      if (!move) return;

      const newState = makeMove(gameState, move.lineType, move.row, move.col);
      const boxesClosed = newState.animatingBoxes.length;

      if (boxesClosed > 0) {
        const p2Score = newState.scores[2];
        const p1Score = newState.scores[1];
        if (boxesClosed >= 3) triggerTaunt('capturing');
        else if (p2Score > p1Score + 4) triggerTaunt('winning');
        else if (p1Score > p2Score + 4) triggerTaunt('losing');
      }

      setGameState(newState);
      if (newState.status === 'finished') { setTimeout(() => onGameOver(newState), 600); }
    }, delay);

    return () => { clearTimeout(timer); setAIThinking(false); };
  }, [gameState.currentPlayer, gameState.moveCount, gameState.status, vsAI, aiDifficulty, triggerTaunt, onGameOver]);

  const gs = gameState;
  const p1Active = gs.currentPlayer === 1 && gs.status === 'playing';
  const p2Active = gs.currentPlayer === 2 && gs.status === 'playing';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1.5rem', borderBottom: '1px solid #0f0f2a', gap: '1rem' }}>
        <button className="btn btn-ghost btn-sm" onClick={onQuit}>← QUIT</button>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <span className="badge badge-cyan" style={{ fontSize: '0.55rem' }}>
            {gs.gridSize - 1}×{gs.gridSize - 1} GRID
          </span>
          <span className={`badge ${gs.mode === 'blitz' ? 'badge-pink' : gs.mode === 'power' ? 'badge-purple' : 'badge-cyan'}`} style={{ fontSize: '0.55rem' }}>
            {gs.mode.toUpperCase()}
          </span>
          {vsAI && <span className="badge badge-yellow" style={{ fontSize: '0.55rem' }}>VS AI: {aiDifficulty.toUpperCase()}</span>}
        </div>
        <div style={{ fontFamily: 'Orbitron', fontSize: '0.6rem', color: '#303060', letterSpacing: '0.1em' }}>
          MOVE {gs.moveCount}
        </div>
      </nav>

      {/* Void mode banner */}
      {voidMode && (
        <div style={{
          background: 'rgba(191,0,255,0.15)',
          border: '1px solid rgba(191,0,255,0.4)',
          padding: '0.6rem 1.5rem',
          textAlign: 'center',
          fontFamily: 'Orbitron',
          fontSize: '0.65rem',
          color: '#bf00ff',
          letterSpacing: '0.15em',
          animation: 'flicker 1s ease infinite',
        }}>
          🌀 VOID ACTIVE — SELECT AN OPPONENT LINE TO ERASE
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: '1rem', fontSize: '0.55rem' }} onClick={() => { setVoidMode(false); setActivePowerUp(null); }}>CANCEL</button>
        </div>
      )}

      {/* AI taunt */}
      {showTaunt && (
        <div style={{
          background: 'rgba(255,0,85,0.1)',
          borderBottom: '1px solid rgba(255,0,85,0.3)',
          padding: '0.5rem 1.5rem',
          textAlign: 'center',
          fontFamily: 'Orbitron',
          fontSize: '0.6rem',
          color: '#ff0055',
          letterSpacing: '0.12em',
          animation: 'slide-in 0.3s ease both',
        }}>
          🤖 NEXUS AI: &quot;{aiTaunt}&quot;
        </div>
      )}

      {/* Main layout */}
      <div style={{ flex: 1, display: 'flex', gap: '1rem', padding: '1rem 1.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* P1 Panel */}
        <div style={{ flex: '0 0 220px', minWidth: '180px' }}>
          <PlayerPanel
            state={gs}
            playerNum={1}
            isActive={p1Active}
            activePowerUp={p1Active ? activePowerUp : null}
            onPowerUp={handlePowerUp}
            surgeBonus={p1Active && surgeBonus}
            cascadeMode={p1Active && cascadeMode}
          />
        </div>

        {/* Board */}
        <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
          {/* Timer */}
          {gs.mode === 'blitz' && (
            <div style={{ width: '100%', maxWidth: '500px' }}>
              <TimerBar state={gs} onTimeout={handleTimeout} />
            </div>
          )}

          {/* Status */}
          <div style={{ fontFamily: 'Orbitron', fontSize: '0.65rem', letterSpacing: '0.15em', color: P_COLOR[gs.currentPlayer], textAlign: 'center', minHeight: '20px' }}>
            {gs.status === 'playing' && (
              aiThinking ? '🤖 NEXUS AI IS COMPUTING...' : `${gs.playerNames[gs.currentPlayer - 1]} — YOUR MOVE`
            )}
            {gs.status === 'finished' && '⚡ GRID COMPLETE'}
          </div>

          {/* Combo flash */}
          {comboFlash && (
            <div style={{
              fontFamily: 'Orbitron',
              fontSize: '1.2rem',
              color: P_COLOR[comboFlash.player],
              textShadow: `0 0 20px ${P_COLOR[comboFlash.player]}`,
              animation: 'combo-pop 1.2s ease both',
              position: 'absolute',
              pointerEvents: 'none',
              zIndex: 10,
            }}>
              ×{comboFlash.count} COMBO!
            </div>
          )}

          <GameBoard
            state={gs}
            onMove={handleMove}
            disabled={isBoardDisabled}
            voidMode={voidMode}
            voidOpponent={voidMode ? (gs.currentPlayer === 1 ? 2 : 1) : null}
          />

          {/* Score summary */}
          <div style={{ display: 'flex', gap: '1.5rem', justifyContent: 'center' }}>
            {[1, 2].map(p => (
              <div key={p} style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: 'Orbitron', fontSize: '0.55rem', color: P_COLOR[p], letterSpacing: '0.15em', marginBottom: '0.2rem' }}>
                  {gs.playerNames[p - 1]}
                </div>
                <div style={{ fontFamily: 'Orbitron', fontSize: '1.5rem', color: P_COLOR[p], fontWeight: 900, textShadow: `0 0 12px ${P_COLOR[p]}` }}>
                  {gs.scores[p]}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* P2 Panel */}
        <div style={{ flex: '0 0 220px', minWidth: '180px' }}>
          <PlayerPanel
            state={gs}
            playerNum={2}
            isActive={p2Active}
            aiThinking={aiThinking && vsAI}
            activePowerUp={p2Active ? activePowerUp : null}
            onPowerUp={handlePowerUp}
            surgeBonus={p2Active && surgeBonus}
            cascadeMode={p2Active && cascadeMode}
          />
        </div>
      </div>
    </div>
  );
}
