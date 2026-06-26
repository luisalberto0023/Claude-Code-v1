import { useState, useEffect, useCallback, useRef } from 'react';
import GameBoard from '../components/GameBoard.jsx';
import { createInitialState, makeMove, applyCascade, applyVoid, skipTurn } from '../game/gameLogic.js';
import { getAIMove, AI_TAUNTS } from '../game/aiPlayer.js';
import { useIsMobile } from '../hooks/useIsMobile.js';

const P_COLOR = ['', '#00f5ff', '#ff0055'];
const P_LABEL = ['', 'CYAN', 'CRIMSON'];

/* ── Shared sub-components ─────────────────────────────── */

function TimerBar({ state, onTimeout }) {
  const [timeLeft, setTimeLeft] = useState(10);
  const lastKey = useRef(`${state.currentPlayer}-${state.moveCount}`);

  useEffect(() => {
    const key = `${state.currentPlayer}-${state.moveCount}`;
    if (key !== lastKey.current) { setTimeLeft(10); lastKey.current = key; }
  }, [state.currentPlayer, state.moveCount]);

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
    <div style={{ padding: '0.4rem 1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
        <span style={{ fontFamily: 'Orbitron', fontSize: '0.55rem', color: '#404070', letterSpacing: '0.15em' }}>⏱ TURN TIMER</span>
        <span style={{ fontFamily: 'Orbitron', fontSize: '0.8rem', color, fontWeight: 700, animation: timeLeft <= 3 ? 'flicker 0.5s infinite' : 'none' }}>
          {String(timeLeft).padStart(2, '0')}
        </span>
      </div>
      <div style={{ height: '4px', background: '#0f0f28', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: `linear-gradient(90deg, ${color}, ${color}aa)`, boxShadow: `0 0 8px ${color}`, borderRadius: '2px', transition: 'width 0.9s linear, background 0.3s' }} />
      </div>
    </div>
  );
}

/* ── Desktop player panel ──────────────────────────────── */

function PlayerPanel({ state, playerNum, isActive, aiThinking, activePowerUp, onPowerUp, surgeBonus, cascadeMode }) {
  const { scores, playerNames, powerUps, totalBoxes } = state;
  const color = P_COLOR[playerNum];
  const pups = powerUps?.[playerNum];
  const score = scores[playerNum];
  const pct = totalBoxes > 0 ? (score / totalBoxes) * 100 : 0;

  return (
    <div style={{
      background: isActive ? `rgba(${playerNum === 1 ? '0,245,255' : '255,0,85'},0.05)` : 'rgba(10,10,31,0.6)',
      border: `1px solid ${isActive ? color : '#1a1a4a'}`,
      borderRadius: '6px',
      padding: '1.25rem',
      transition: 'all 0.3s',
      boxShadow: isActive ? `0 0 20px ${color}20` : 'none',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
        <div>
          <div style={{ fontFamily: 'Orbitron', fontSize: '0.5rem', color, letterSpacing: '0.2em', marginBottom: '0.2rem' }}>{P_LABEL[playerNum]} UNIT</div>
          <div style={{ fontFamily: 'Orbitron', fontSize: '0.8rem', color: isActive ? color : '#c0c0ff', fontWeight: 700 }}>{playerNames[playerNum - 1]}</div>
        </div>
        {isActive && !aiThinking && <span className="badge" style={{ background: `${color}20`, color, border: `1px solid ${color}50`, fontSize: '0.5rem', animation: 'flicker 1.5s ease infinite' }}>TURN</span>}
        {aiThinking && <span className="badge badge-yellow" style={{ fontSize: '0.5rem', animation: 'flicker 0.8s ease infinite' }}>CALC</span>}
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
          <span style={{ fontSize: '0.6rem', color: '#404070', fontFamily: 'Orbitron', letterSpacing: '0.1em' }}>SECTORS</span>
          <span style={{ fontFamily: 'Orbitron', fontSize: '1.4rem', color, fontWeight: 900, lineHeight: 1 }}>{score}</span>
        </div>
        <div style={{ height: '3px', background: '#0f0f28', borderRadius: '2px', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: color, boxShadow: `0 0 6px ${color}`, borderRadius: '2px', transition: 'width 0.4s ease' }} />
        </div>
        <div style={{ fontSize: '0.55rem', color: '#303060', marginTop: '0.25rem' }}>{score}/{totalBoxes}</div>
      </div>

      {isActive && state.comboCount > 1 && <div style={{ marginBottom: '0.75rem' }}><span className="badge badge-yellow" style={{ fontSize: '0.55rem' }}>🔥 ×{state.comboCount} COMBO</span></div>}
      {isActive && surgeBonus && <div style={{ marginBottom: '0.75rem' }}><span className="badge badge-cyan" style={{ fontSize: '0.55rem' }}>⚡ SURGE — BONUS MOVE</span></div>}
      {isActive && cascadeMode && <div style={{ marginBottom: '0.75rem' }}><span className="badge badge-purple" style={{ fontSize: '0.55rem' }}>💥 CASCADE READY</span></div>}

      {pups && (
        <div>
          <div style={{ fontFamily: 'Orbitron', fontSize: '0.5rem', color: '#303060', letterSpacing: '0.15em', marginBottom: '0.5rem' }}>POWER-UPS</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            {[
              { id: 'surge', icon: '⚡', label: 'SURGE', desc: 'Bonus move', charges: pups.surge, color: '#00f5ff' },
              { id: 'void', icon: '🌀', label: 'VOID', desc: 'Erase last', charges: pups.void, color: '#bf00ff' },
              { id: 'cascade', icon: '💥', label: 'CASCADE', desc: 'Chain claim', charges: pups.cascade, color: '#ffd700' },
            ].map(pu => {
              const isAct = activePowerUp === pu.id;
              const canUse = isActive && pu.charges > 0 && !activePowerUp && state.currentPlayer === playerNum;
              return (
                <button key={pu.id} onClick={() => canUse && onPowerUp(pu.id)} disabled={!canUse} style={{
                  background: isAct ? `${pu.color}18` : 'rgba(5,5,16,0.6)',
                  border: `1px solid ${isAct ? pu.color : pu.charges > 0 ? '#1e1e4a' : '#0f0f24'}`,
                  borderRadius: '3px', padding: '0.4rem 0.6rem',
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  cursor: canUse ? 'pointer' : 'default', opacity: pu.charges === 0 ? 0.35 : 1,
                  boxShadow: isAct ? `0 0 10px ${pu.color}40` : 'none', transition: 'all 0.2s', width: '100%',
                }}>
                  <span style={{ fontSize: '0.85rem' }}>{pu.icon}</span>
                  <div style={{ flex: 1, textAlign: 'left' }}>
                    <div style={{ fontFamily: 'Orbitron', fontSize: '0.48rem', color: isAct ? pu.color : '#8080c0', letterSpacing: '0.1em' }}>{pu.label}</div>
                    <div style={{ fontSize: '0.58rem', color: '#303060' }}>{pu.desc}</div>
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

/* ── Mobile-specific components ────────────────────────── */

function MobileScoreBar({ state, aiThinking }) {
  const { scores, playerNames, currentPlayer, totalBoxes } = state;
  return (
    <div style={{ display: 'flex', borderBottom: '1px solid #0f0f2a' }}>
      {[1, 2].map(p => {
        const isActive = currentPlayer === p && state.status === 'playing';
        const color = P_COLOR[p];
        const pct = totalBoxes > 0 ? (scores[p] / totalBoxes) * 100 : 0;
        return (
          <div key={p} style={{
            flex: 1,
            padding: '0.6rem 0.75rem',
            background: isActive ? `rgba(${p === 1 ? '0,245,255' : '255,0,85'},0.06)` : 'transparent',
            borderBottom: isActive ? `2px solid ${color}` : '2px solid transparent',
            transition: 'all 0.3s',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.3rem',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontFamily: 'Orbitron', fontSize: '0.5rem', color: '#404070', letterSpacing: '0.12em' }}>P{p} {P_LABEL[p]}</div>
                <div style={{ fontFamily: 'Orbitron', fontSize: '0.65rem', color: isActive ? color : '#8080b0', maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {playerNames[p - 1]}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                {isActive && !aiThinking && <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: color, animation: 'flicker 1s ease infinite' }} />}
                {aiThinking && p === 2 && <span style={{ fontFamily: 'Orbitron', fontSize: '0.45rem', color: '#ffd700', animation: 'flicker 0.8s ease infinite' }}>CALC</span>}
                <div style={{ fontFamily: 'Orbitron', fontSize: '1.5rem', color, fontWeight: 900, lineHeight: 1 }}>{scores[p]}</div>
              </div>
            </div>
            <div style={{ height: '2px', background: '#0a0a1f', borderRadius: '1px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: color, transition: 'width 0.4s ease' }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MobilePowerBar({ state, activePowerUp, onPowerUp, surgeBonus, cascadeMode, voidMode, onCancelVoid }) {
  const player = state.currentPlayer;
  const pups = state.powerUps?.[player];
  if (!pups) return null;

  const powers = [
    { id: 'surge', icon: '⚡', label: 'SURGE', color: '#00f5ff', charges: pups.surge },
    { id: 'void', icon: '🌀', label: 'VOID', color: '#bf00ff', charges: pups.void },
    { id: 'cascade', icon: '💥', label: 'CASCADE', color: '#ffd700', charges: pups.cascade },
  ];

  return (
    <div style={{ borderTop: '1px solid #0f0f2a', background: '#050510' }}>
      {(surgeBonus || cascadeMode || voidMode) && (
        <div style={{ padding: '0.3rem 1rem', textAlign: 'center', fontFamily: 'Orbitron', fontSize: '0.55rem', letterSpacing: '0.12em', animation: 'flicker 1s ease infinite',
          color: voidMode ? '#bf00ff' : surgeBonus ? '#00f5ff' : '#ffd700' }}>
          {voidMode ? '🌀 SELECT OPPONENT LINE TO ERASE' : surgeBonus ? '⚡ SURGE — DRAW BONUS LINE' : '💥 CASCADE ACTIVE — CHAIN WILL TRIGGER'}
          {voidMode && <button onClick={onCancelVoid} style={{ marginLeft: '0.75rem', background: 'none', border: '1px solid #303060', borderRadius: '3px', color: '#5060a0', fontSize: '0.5rem', padding: '0.2rem 0.5rem', cursor: 'pointer', fontFamily: 'Orbitron' }}>CANCEL</button>}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', padding: '0.6rem 1rem' }}>
        {powers.map(pu => {
          const isAct = activePowerUp === pu.id;
          const canUse = pu.charges > 0 && !activePowerUp;
          return (
            <button key={pu.id} onClick={() => canUse && onPowerUp(pu.id)} style={{
              background: isAct ? `${pu.color}20` : 'rgba(10,10,31,0.8)',
              border: `1px solid ${isAct ? pu.color : pu.charges > 0 ? '#1e1e4a' : '#0a0a1f'}`,
              borderRadius: '6px', padding: '0.55rem 0.9rem',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem',
              opacity: pu.charges === 0 ? 0.35 : 1,
              cursor: canUse ? 'pointer' : 'default',
              boxShadow: isAct ? `0 0 12px ${pu.color}40` : 'none',
              minWidth: '70px',
            }}>
              <span style={{ fontSize: '1.2rem' }}>{pu.icon}</span>
              <div style={{ fontFamily: 'Orbitron', fontSize: '0.45rem', color: isAct ? pu.color : '#5060a0', letterSpacing: '0.1em' }}>{pu.label}</div>
              <div style={{ display: 'flex', gap: '3px' }}>
                {Array.from({ length: 2 }, (_, i) => (
                  <div key={i} style={{ width: '5px', height: '5px', borderRadius: '50%', background: i < pu.charges ? pu.color : '#0f0f28', boxShadow: i < pu.charges ? `0 0 4px ${pu.color}` : 'none' }} />
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Main GamePage ─────────────────────────────────────── */

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
  const isMobile = useIsMobile();

  const { vsAI, aiDifficulty } = config;
  const isBoardDisabled = aiThinking || (vsAI && gameState.currentPlayer === 2) || gameState.status !== 'playing';

  const triggerTaunt = useCallback((type) => {
    const pool = AI_TAUNTS[type] || AI_TAUNTS.neutral;
    setAITaunt(pool[Math.floor(Math.random() * pool.length)]);
    setShowTaunt(true);
    setTimeout(() => setShowTaunt(false), 3000);
  }, []);

  const cancelPowerUp = useCallback(() => {
    setActivePowerUp(null);
    setVoidMode(false);
    setCascadeMode(false);
    setSurgeBonus(false);
    setSurgeConsumed(false);
  }, []);

  const handleMove = useCallback((lineType, row, col) => {
    if (gameState.status !== 'playing') return;

    if (voidMode) {
      const newState = applyVoid(gameState);
      setVoidMode(false);
      setActivePowerUp(null);
      setGameState(newState);
      if (newState.status === 'finished') setTimeout(() => onGameOver(newState), 600);
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
      if (newState.status === 'finished') setTimeout(() => onGameOver(newState), 600);
      return;
    }

    if (surgeConsumed) { setSurgeBonus(false); setSurgeConsumed(false); }

    setGameState(newState);
    if (newState.status === 'finished') setTimeout(() => onGameOver(newState), 600);
  }, [gameState, voidMode, cascadeMode, surgeBonus, surgeConsumed, onGameOver]);

  const handlePowerUp = useCallback((id) => {
    if (activePowerUp === id) { cancelPowerUp(); return; }
    const player = gameState.currentPlayer;
    const charges = gameState.powerUps?.[player]?.[id] || 0;
    if (charges <= 0) return;
    setActivePowerUp(id);
    const newPowerUps = { ...gameState.powerUps, [player]: { ...gameState.powerUps[player], [id]: charges - 1 } };
    setGameState(s => ({ ...s, powerUps: newPowerUps }));
    if (id === 'surge') { setSurgeBonus(true); setSurgeConsumed(false); }
    if (id === 'void') setVoidMode(true);
    if (id === 'cascade') setCascadeMode(true);
  }, [activePowerUp, gameState, cancelPowerUp]);

  const handleTimeout = useCallback(() => {
    if (vsAI && gameState.currentPlayer === 2) return;
    setGameState(skipTurn(gameState));
    cancelPowerUp();
  }, [gameState, vsAI, cancelPowerUp]);

  useEffect(() => {
    if (!vsAI || gameState.currentPlayer !== 2 || gameState.status !== 'playing') return;
    setAIThinking(true);
    const timer = setTimeout(() => {
      const move = getAIMove(gameState, aiDifficulty);
      setAIThinking(false);
      if (!move) return;
      const newState = makeMove(gameState, move.lineType, move.row, move.col);
      const boxesClosed = newState.animatingBoxes.length;
      if (boxesClosed >= 3) triggerTaunt('capturing');
      else if (newState.scores[2] > newState.scores[1] + 4) triggerTaunt('winning');
      else if (newState.scores[1] > newState.scores[2] + 4) triggerTaunt('losing');
      setGameState(newState);
      if (newState.status === 'finished') setTimeout(() => onGameOver(newState), 600);
    }, 600 + Math.random() * 600);
    return () => { clearTimeout(timer); setAIThinking(false); };
  }, [gameState.currentPlayer, gameState.moveCount, gameState.status, vsAI, aiDifficulty, triggerTaunt, onGameOver]);

  const gs = gameState;
  const p1Active = gs.currentPlayer === 1 && gs.status === 'playing';
  const p2Active = gs.currentPlayer === 2 && gs.status === 'playing';

  /* ── Top nav (shared) ── */
  const navBar = (
    <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: `${isMobile ? '0.6rem 0.75rem' : '0.75rem 1.5rem'}`, borderBottom: '1px solid #0f0f2a', flexShrink: 0, gap: '0.5rem' }}>
      <button className="btn btn-ghost btn-sm" onClick={onQuit} style={{ fontSize: '0.6rem' }}>← QUIT</button>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        <span className="badge badge-cyan" style={{ fontSize: '0.5rem' }}>{gs.gridSize - 1}×{gs.gridSize - 1}</span>
        <span className={`badge ${gs.mode === 'blitz' ? 'badge-pink' : gs.mode === 'power' ? 'badge-purple' : 'badge-cyan'}`} style={{ fontSize: '0.5rem' }}>{gs.mode.toUpperCase()}</span>
        {vsAI && !isMobile && <span className="badge badge-yellow" style={{ fontSize: '0.5rem' }}>AI: {aiDifficulty.toUpperCase()}</span>}
      </div>
      <div style={{ fontFamily: 'Orbitron', fontSize: '0.55rem', color: '#303060', letterSpacing: '0.1em' }}>#{gs.moveCount}</div>
    </nav>
  );

  /* ── Void banner (shared) ── */
  const voidBanner = voidMode && !isMobile && (
    <div style={{ background: 'rgba(191,0,255,0.15)', border: '1px solid rgba(191,0,255,0.4)', padding: '0.5rem 1.5rem', textAlign: 'center', fontFamily: 'Orbitron', fontSize: '0.6rem', color: '#bf00ff', letterSpacing: '0.12em', animation: 'flicker 1s ease infinite' }}>
      🌀 VOID ACTIVE — SELECT AN OPPONENT LINE TO ERASE
      <button className="btn btn-ghost btn-sm" style={{ marginLeft: '1rem', fontSize: '0.5rem' }} onClick={cancelPowerUp}>CANCEL</button>
    </div>
  );

  /* ── AI taunt (shared) ── */
  const tauntBar = showTaunt && (
    <div style={{ background: 'rgba(255,0,85,0.1)', borderBottom: '1px solid rgba(255,0,85,0.25)', padding: '0.4rem 1.5rem', textAlign: 'center', fontFamily: 'Orbitron', fontSize: '0.55rem', color: '#ff0055', letterSpacing: '0.1em', animation: 'slide-in 0.3s ease both' }}>
      🤖 &quot;{aiTaunt}&quot;
    </div>
  );

  /* ── Board + status center ── */
  const board = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
      <div style={{ fontFamily: 'Orbitron', fontSize: isMobile ? '0.55rem' : '0.6rem', letterSpacing: '0.15em', color: P_COLOR[gs.currentPlayer], textAlign: 'center', minHeight: '18px' }}>
        {gs.status === 'playing' && (aiThinking ? '🤖 NEXUS AI IS COMPUTING...' : `${gs.playerNames[gs.currentPlayer - 1]} — YOUR MOVE`)}
        {gs.status === 'finished' && '⚡ GRID COMPLETE'}
      </div>

      {comboFlash && (
        <div style={{ fontFamily: 'Orbitron', fontSize: '1.1rem', color: P_COLOR[comboFlash.player], textShadow: `0 0 16px ${P_COLOR[comboFlash.player]}`, animation: 'combo-pop 1.2s ease both', position: 'absolute', zIndex: 10, pointerEvents: 'none' }}>
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
    </div>
  );

  /* ── MOBILE LAYOUT ── */
  if (isMobile) {
    return (
      <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {navBar}
        <MobileScoreBar state={gs} aiThinking={aiThinking && vsAI} />
        <TimerBar state={gs} onTimeout={handleTimeout} />
        {tauntBar}

        {/* Board area — flex grows to fill remaining space */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0.5rem 0.75rem', overflow: 'hidden', position: 'relative' }}>
          {gs.comboCount > 1 && <div style={{ fontFamily: 'Orbitron', fontSize: '0.6rem', color: '#ffd700', textShadow: '0 0 10px #ffd700', marginBottom: '0.3rem' }}>🔥 ×{gs.comboCount} COMBO</div>}
          {surgeBonus && <div style={{ fontFamily: 'Orbitron', fontSize: '0.55rem', color: '#00f5ff', marginBottom: '0.3rem' }}>⚡ SURGE — BONUS MOVE AVAILABLE</div>}
          {board}
        </div>

        {/* Bottom: power-ups or score fallback */}
        {gs.mode === 'power' && gs.currentPlayer === 1 && gs.status === 'playing' && (
          <MobilePowerBar
            state={gs}
            activePowerUp={activePowerUp}
            onPowerUp={handlePowerUp}
            surgeBonus={surgeBonus}
            cascadeMode={cascadeMode}
            voidMode={voidMode}
            onCancelVoid={cancelPowerUp}
          />
        )}

        {/* Compact bottom scores when no power bar */}
        {!(gs.mode === 'power' && gs.currentPlayer === 1 && gs.status === 'playing') && (
          <div style={{ borderTop: '1px solid #0f0f2a', padding: '0.5rem 1rem', display: 'flex', justifyContent: 'center', gap: '2rem' }}>
            {[1, 2].map(p => (
              <div key={p} style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: 'Orbitron', fontSize: '0.45rem', color: '#303060', letterSpacing: '0.12em' }}>{gs.playerNames[p - 1]}</div>
                <div style={{ fontFamily: 'Orbitron', fontSize: '1.1rem', color: P_COLOR[p], fontWeight: 900 }}>{gs.scores[p]}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  /* ── DESKTOP LAYOUT ── */
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {navBar}
      {voidBanner}
      {tauntBar}

      <div style={{ flex: 1, display: 'flex', gap: '1rem', padding: '1rem 1.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 220px', minWidth: '180px' }}>
          <PlayerPanel state={gs} playerNum={1} isActive={p1Active}
            activePowerUp={p1Active ? activePowerUp : null} onPowerUp={handlePowerUp}
            surgeBonus={p1Active && surgeBonus} cascadeMode={p1Active && cascadeMode} />
        </div>

        <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', position: 'relative' }}>
          {gs.mode === 'blitz' && <div style={{ width: '100%', maxWidth: '500px' }}><TimerBar state={gs} onTimeout={handleTimeout} /></div>}
          {board}
          <div style={{ display: 'flex', gap: '2rem', justifyContent: 'center' }}>
            {[1, 2].map(p => (
              <div key={p} style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: 'Orbitron', fontSize: '0.5rem', color: P_COLOR[p], letterSpacing: '0.15em', marginBottom: '0.2rem' }}>{gs.playerNames[p - 1]}</div>
                <div style={{ fontFamily: 'Orbitron', fontSize: '1.5rem', color: P_COLOR[p], fontWeight: 900, textShadow: `0 0 12px ${P_COLOR[p]}` }}>{gs.scores[p]}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ flex: '0 0 220px', minWidth: '180px' }}>
          <PlayerPanel state={gs} playerNum={2} isActive={p2Active} aiThinking={aiThinking && vsAI}
            activePowerUp={p2Active ? activePowerUp : null} onPowerUp={handlePowerUp}
            surgeBonus={p2Active && surgeBonus} cascadeMode={p2Active && cascadeMode} />
        </div>
      </div>
    </div>
  );
}
