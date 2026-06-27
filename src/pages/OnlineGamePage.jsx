import { useEffect, useRef, useState } from 'react';
import GameBoard from '../components/GameBoard.jsx';
import SoundToggle from '../components/SoundToggle.jsx';
import { makeMove } from '../game/gameLogic.js';
import { audio } from '../game/audio.js';
import { subscribeRoom, pushState, requestRematch, leaveRoom, roleOf, clientId } from '../online/online.js';

const P_COLOR = ['', '#00f5ff', '#ff0055'];
const insets = {
  paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
  paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)',
};

export default function OnlineGamePage({ code, onQuit }) {
  const [data, setData] = useState(null);
  const [optimistic, setOptimistic] = useState(null);
  const [connError, setConnError] = useState('');
  const prevMoveCount = useRef(0);

  // Subscribe to the room document.
  useEffect(() => {
    let unsub = null, alive = true;
    subscribeRoom(code, d => { if (alive) { setData(d); setOptimistic(null); } })
      .then(u => { unsub = u; if (!alive) u(); })
      .catch(e => setConnError(e.message || 'Connection failed.'));
    return () => { alive = false; if (unsub) unsub(); };
  }, [code]);

  const role = roleOf(data);
  const gameState = optimistic || (data?.stateJson ? safeParse(data.stateJson) : null);

  // Sound for opponent moves (own moves play in handleMove).
  useEffect(() => {
    if (!gameState) return;
    const mc = gameState.moveCount || 0;
    if (mc > prevMoveCount.current && optimistic == null && prevMoveCount.current !== 0) {
      audio.lineDraw(gameState.currentPlayer === 1 ? 2 : 1);
    }
    prevMoveCount.current = mc;
  }, [gameState, optimistic]);

  if (connError) return <Centered>{`⚠ ${connError}`}<LeaveBtn code={code} onQuit={onQuit} /></Centered>;
  if (!data) return <Centered>CONNECTING…</Centered>;
  if (!gameState) return <Centered>{'⚠ Room data unavailable.'}<LeaveBtn code={code} onQuit={onQuit} /></Centered>;

  const status = data.status;
  const myTurn = status === 'playing' && gameState.currentPlayer === role && gameState.status === 'playing';
  const names = [data.names?.p1 || 'PLAYER 1', data.names?.p2 || 'PLAYER 2'];

  function handleMove(lineType, row, col) {
    if (!myTurn) return;
    const next = makeMove(gameState, lineType, row, col);
    if (next === gameState) return;
    audio.lineDraw(role);
    if (next.animatingBoxes.length > 0) audio.capture(next.comboCount || next.animatingBoxes.length);
    setOptimistic(next);
    pushState(code, next).catch(e => setConnError(e.message || 'Failed to send move.'));
  }

  const finished = gameState.status === 'finished';
  const opponentLeft = status === 'abandoned' && data.abandonedBy && data.abandonedBy !== clientId();

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden', ...insets }}>
      {/* Nav */}
      <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 0.75rem', borderBottom: '1px solid #0f0f2a' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => { audio.click(); leaveRoom(code); onQuit(); }} style={{ fontSize: '0.6rem' }}>← LEAVE</button>
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          <span className="badge badge-purple" style={{ fontSize: '0.5rem' }}>ONLINE</span>
          <span className="badge badge-cyan" style={{ fontSize: '0.5rem' }}>ROOM {code}</span>
        </div>
        <SoundToggle compact />
      </nav>

      {/* Scores */}
      <div style={{ display: 'flex', borderBottom: '1px solid #0f0f2a' }}>
        {[1, 2].map(p => {
          const active = gameState.currentPlayer === p && status === 'playing' && !finished;
          const color = P_COLOR[p];
          const isMe = role === p;
          return (
            <div key={p} style={{
              flex: 1, padding: '0.6rem 0.75rem',
              background: active ? `rgba(${p === 1 ? '0,245,255' : '255,0,85'},0.06)` : 'transparent',
              borderBottom: active ? `2px solid ${color}` : '2px solid transparent',
            }}>
              <div style={{ fontFamily: 'Orbitron', fontSize: '0.5rem', color: '#404070', letterSpacing: '0.1em' }}>
                P{p} {isMe ? '· YOU' : ''}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontFamily: 'Orbitron', fontSize: '0.65rem', color: active ? color : '#8080b0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '110px' }}>{names[p - 1]}</span>
                <span style={{ fontFamily: 'Orbitron', fontSize: '1.4rem', color, fontWeight: 900, lineHeight: 1 }}>{gameState.scores[p]}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Board */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0.5rem 0.75rem', position: 'relative', overflow: 'hidden' }}>
        <div style={{ fontFamily: 'Orbitron', fontSize: '0.55rem', letterSpacing: '0.15em', color: P_COLOR[gameState.currentPlayer], minHeight: '16px', marginBottom: '0.4rem' }}>
          {status === 'playing' && !finished && (myTurn ? '● YOUR MOVE' : `○ ${names[gameState.currentPlayer - 1]}'S MOVE`)}
        </div>
        <GameBoard state={gameState} onMove={handleMove} disabled={!myTurn} voidMode={false} voidOpponent={null} />
      </div>

      {/* Overlays */}
      {status === 'waiting' && <WaitingOverlay code={code} />}
      {opponentLeft && <ResultOverlay title="OPPONENT LEFT" color="#ffd700" sub="They disconnected from the match." onQuit={onQuit} code={code} />}
      {finished && !opponentLeft && (
        <ResultOverlay
          title={gameState.winner === 'draw' ? 'DRAW' : `${names[gameState.winner - 1]} WINS`}
          color={gameState.winner === 'draw' ? '#ffd700' : P_COLOR[gameState.winner]}
          sub={gameState.winner === role ? '◆ You dominated the grid!' : gameState.winner === 'draw' ? 'Grid synchronized.' : 'Better luck next match.'}
          onQuit={onQuit}
          code={code}
          onRematch={role === 1 ? () => { audio.click(); requestRematch(code, { gridSize: data.config.gridSize, mode: 'classic', vsAI: false }, data.rematchSeq); } : null}
          rematchHint={role === 2 ? 'Waiting for host to start a rematch…' : null}
        />
      )}
    </div>
  );
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function Centered({ children }) {
  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', ...insets, fontFamily: 'Orbitron', fontSize: '0.8rem', color: '#8080c0', letterSpacing: '0.15em', textAlign: 'center', padding: '2rem' }}>
      {children}
    </div>
  );
}

function LeaveBtn({ code, onQuit }) {
  return <button className="btn btn-ghost btn-sm" onClick={() => { leaveRoom(code); onQuit(); }}>← BACK TO MENU</button>;
}

function WaitingOverlay({ code }) {
  return (
    <Overlay>
      <div style={{ fontFamily: 'Orbitron', fontSize: '0.65rem', color: '#bf00ff', letterSpacing: '0.2em', marginBottom: '0.75rem' }}>◆ WAITING FOR OPPONENT</div>
      <div style={{ fontSize: '0.85rem', color: '#8080c0', marginBottom: '1rem' }}>Share this code with your opponent:</div>
      <div style={{ fontFamily: 'Orbitron', fontSize: '2.6rem', fontWeight: 900, color: '#00f5ff', letterSpacing: '0.3em', textShadow: '0 0 20px #00f5ff', marginBottom: '1.25rem' }}>{code}</div>
      <button className="btn btn-ghost btn-sm" onClick={() => { audio.click(); navigator.clipboard?.writeText(code).catch(() => {}); }}>⧉ COPY CODE</button>
      <div style={{ marginTop: '1.5rem' }}><span className="badge badge-purple" style={{ fontSize: '0.55rem', animation: 'flicker 1.2s ease infinite' }}>● LISTENING…</span></div>
    </Overlay>
  );
}

function ResultOverlay({ title, color, sub, onQuit, code, onRematch, rematchHint }) {
  return (
    <Overlay>
      <div style={{ fontFamily: 'Orbitron', fontSize: 'clamp(1.4rem,7vw,2.4rem)', fontWeight: 900, color, textShadow: `0 0 24px ${color}`, letterSpacing: '0.06em', marginBottom: '0.5rem', textAlign: 'center' }}>{title}</div>
      <div style={{ fontSize: '0.85rem', color: '#8080c0', marginBottom: '1.5rem' }}>{sub}</div>
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        {onRematch && <button className="btn btn-primary btn-lg" onClick={onRematch}>⚡ REMATCH</button>}
        <button className="btn btn-ghost btn-lg" onClick={() => { audio.click(); leaveRoom(code); onQuit(); }}>◈ LEAVE</button>
      </div>
      {rematchHint && <div style={{ marginTop: '1rem', fontSize: '0.7rem', color: '#5060a0', fontFamily: 'Orbitron', letterSpacing: '0.1em', animation: 'flicker 1.2s ease infinite' }}>{rematchHint}</div>}
    </Overlay>
  );
}

function Overlay({ children }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(3,7,18,0.92)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', zIndex: 50, backdropFilter: 'blur(6px)', ...insets }}>
      {children}
    </div>
  );
}
