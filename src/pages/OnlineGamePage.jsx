import { useEffect, useRef, useState } from 'react';
import GameBoard from '../components/GameBoard.jsx';
import SoundToggle from '../components/SoundToggle.jsx';
import { audio } from '../game/audio.js';

const P_COLOR = ['', '#00f5ff', '#ff0055'];
const insets = {
  paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
  paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)',
};

export default function OnlineGamePage({ room, onQuit }) {
  const [you, setYou] = useState(0);          // player number from "welcome"
  const [data, setData] = useState(null);     // latest "sync" payload
  const [connError, setConnError] = useState('');
  const prevMC = useRef(0);
  const prevScore = useRef(0);
  const pendingMine = useRef(false);
  const left = useRef(false);

  // Wire up room listeners once.
  useEffect(() => {
    if (!room) return;
    room.onMessage('welcome', m => setYou(m.you));
    room.onMessage('sync', p => setData(p));
    room.onMessage('rejected', () => { pendingMine.current = false; audio.invalid(); });
    room.onError?.((c, m) => setConnError(m || 'Connection error.'));
    room.onLeave?.(() => { if (!left.current) setConnError('Disconnected from server.'); });
    return () => { if (!left.current) { left.current = true; try { room.leave(); } catch { /* ignore */ } } };
  }, [room]);

  const gameState = data?.state || null;

  // Move + capture sounds, including the opponent's moves.
  useEffect(() => {
    if (!gameState) return;
    const mc = gameState.moveCount || 0;
    const score = (gameState.scores?.[1] || 0) + (gameState.scores?.[2] || 0);
    if (mc > prevMC.current) {
      if (pendingMine.current) pendingMine.current = false;     // my own move (already chimed on tap)
      else audio.lineDraw(gameState.currentPlayer);             // opponent moved
      if (score > prevScore.current) audio.capture(score - prevScore.current);
    }
    prevMC.current = mc;
    prevScore.current = score;
  }, [gameState]);

  function quit() {
    left.current = true;
    try { room?.leave(); } catch { /* ignore */ }
    onQuit();
  }

  if (connError) return <Centered>{`⚠ ${connError}`}<MenuBtn onClick={quit} /></Centered>;
  if (!data || !gameState) return <Centered>CONNECTING…</Centered>;

  const status = data.status;
  const names = [data.names?.[1] || 'PLAYER 1', data.names?.[2] || 'PLAYER 2'];
  const finished = gameState.status === 'finished';
  const myTurn = status === 'playing' && !finished && gameState.currentPlayer === you;
  const opponentLeft = status === 'abandoned' && data.abandonedBy && data.abandonedBy !== you;

  function handleMove(lineType, row, col) {
    if (!myTurn) return;
    pendingMine.current = true;
    audio.lineDraw(you);
    room.send('move', { lineType, row, col });
  }

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden', ...insets }}>
      <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 0.75rem', borderBottom: '1px solid #0f0f2a' }}>
        <button className="btn btn-ghost btn-sm" onClick={quit} style={{ fontSize: '0.6rem' }}>← LEAVE</button>
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          <span className="badge badge-purple" style={{ fontSize: '0.5rem' }}>ONLINE</span>
          {data.code ? <span className="badge badge-cyan" style={{ fontSize: '0.5rem' }}>ROOM {data.code}</span> : <span className="badge badge-pink" style={{ fontSize: '0.5rem' }}>QUICK</span>}
        </div>
        <SoundToggle compact />
      </nav>

      {/* Scores */}
      <div style={{ display: 'flex', borderBottom: '1px solid #0f0f2a' }}>
        {[1, 2].map(p => {
          const active = gameState.currentPlayer === p && status === 'playing' && !finished;
          const color = P_COLOR[p];
          return (
            <div key={p} style={{
              flex: 1, padding: '0.6rem 0.75rem',
              background: active ? `rgba(${p === 1 ? '0,245,255' : '255,0,85'},0.06)` : 'transparent',
              borderBottom: active ? `2px solid ${color}` : '2px solid transparent',
            }}>
              <div style={{ fontFamily: 'Orbitron', fontSize: '0.5rem', color: '#404070', letterSpacing: '0.1em' }}>P{p} {you === p ? '· YOU' : ''}</div>
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
      {status === 'waiting' && <WaitingOverlay code={data.code} />}
      {opponentLeft && <ResultOverlay title="OPPONENT LEFT" color="#ffd700" sub="They disconnected from the match." onQuit={quit} />}
      {finished && !opponentLeft && (
        <ResultOverlay
          title={gameState.winner === 'draw' ? 'DRAW' : `${names[gameState.winner - 1]} WINS`}
          color={gameState.winner === 'draw' ? '#ffd700' : P_COLOR[gameState.winner]}
          sub={gameState.winner === you ? '◆ You dominated the grid!' : gameState.winner === 'draw' ? 'Grid synchronized.' : 'Better luck next match.'}
          onQuit={quit}
          onRematch={you === 1 ? () => { audio.click(); room.send('rematch'); } : null}
          rematchHint={you === 2 ? 'Waiting for host to start a rematch…' : null}
        />
      )}
    </div>
  );
}

function Centered({ children }) {
  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', ...insets, fontFamily: 'Orbitron', fontSize: '0.8rem', color: '#8080c0', letterSpacing: '0.12em', textAlign: 'center', padding: '2rem' }}>
      {children}
    </div>
  );
}

function MenuBtn({ onClick }) {
  return <button className="btn btn-ghost btn-sm" onClick={onClick}>← BACK TO MENU</button>;
}

function WaitingOverlay({ code }) {
  return (
    <Overlay>
      <div style={{ fontFamily: 'Orbitron', fontSize: '0.65rem', color: '#bf00ff', letterSpacing: '0.2em', marginBottom: '0.75rem' }}>◆ WAITING FOR OPPONENT</div>
      {code ? (
        <>
          <div style={{ fontSize: '0.85rem', color: '#8080c0', marginBottom: '1rem' }}>Share this code:</div>
          <div style={{ fontFamily: 'Orbitron', fontSize: '2.6rem', fontWeight: 900, color: '#00f5ff', letterSpacing: '0.3em', textShadow: '0 0 20px #00f5ff', marginBottom: '1.25rem' }}>{code}</div>
          <button className="btn btn-ghost btn-sm" onClick={() => { audio.click(); navigator.clipboard?.writeText(code).catch(() => {}); }}>⧉ COPY CODE</button>
        </>
      ) : (
        <div style={{ fontSize: '0.9rem', color: '#8080c0' }}>Searching for an opponent…</div>
      )}
      <div style={{ marginTop: '1.5rem' }}><span className="badge badge-purple" style={{ fontSize: '0.55rem', animation: 'flicker 1.2s ease infinite' }}>● LISTENING…</span></div>
    </Overlay>
  );
}

function ResultOverlay({ title, color, sub, onQuit, onRematch, rematchHint }) {
  return (
    <Overlay>
      <div style={{ fontFamily: 'Orbitron', fontSize: 'clamp(1.4rem,7vw,2.4rem)', fontWeight: 900, color, textShadow: `0 0 24px ${color}`, letterSpacing: '0.06em', marginBottom: '0.5rem', textAlign: 'center' }}>{title}</div>
      <div style={{ fontSize: '0.85rem', color: '#8080c0', marginBottom: '1.5rem' }}>{sub}</div>
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        {onRematch && <button className="btn btn-primary btn-lg" onClick={onRematch}>⚡ REMATCH</button>}
        <button className="btn btn-ghost btn-lg" onClick={onQuit}>◈ LEAVE</button>
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
