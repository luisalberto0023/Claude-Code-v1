import { useState } from 'react';
import { audio } from '../game/audio.js';

const GRID_OPTS = [
  { size: 4, label: '3×3', boxes: 9, desc: 'QUICK', time: '~5m' },
  { size: 5, label: '4×4', boxes: 16, desc: 'STANDARD', time: '~10m' },
  { size: 6, label: '5×5', boxes: 25, desc: 'EXTENDED', time: '~20m' },
  { size: 7, label: '6×6', boxes: 36, desc: 'CAMPAIGN', time: '~35m' },
];

const MODE_OPTS = [
  { id: 'classic', label: 'CLASSIC', icon: '◈', desc: 'Standard rules, no time limit.', color: '#00f5ff' },
  { id: 'blitz', label: 'BLITZ', icon: '⚡', desc: '10 seconds per turn — think fast!', color: '#ff0055' },
  { id: 'power', label: 'POWER MODE', icon: '💥', desc: 'Deploy Surge, Void & Cascade abilities.', color: '#bf00ff' },
];

const DIFF_OPTS = [
  { id: 'easy', label: 'RECRUIT', icon: '◉', desc: 'Random play — great for beginners.', color: '#00ff88' },
  { id: 'medium', label: 'OPERATIVE', icon: '◎', desc: 'Avoids giving free boxes. Real challenge.', color: '#ffd700' },
  { id: 'hard', label: 'NEXUS CORE', icon: '⬡', desc: 'Advanced chain strategy. Ruthless.', color: '#ff0055' },
];

function OptionCard({ selected, onClick, color = '#00f5ff', children }) {
  const rgb = color === '#00f5ff' ? '0,245,255' : color === '#ff0055' ? '255,0,85' : color === '#bf00ff' ? '191,0,255' : color === '#ffd700' ? '255,215,0' : '0,255,136';
  return (
    <button onClick={onClick} style={{
      background: selected ? `rgba(${rgb},0.07)` : 'rgba(10,10,31,0.5)',
      border: `1px solid ${selected ? color : '#1a1a4a'}`,
      borderRadius: '4px', padding: '0.85rem 1rem',
      cursor: 'pointer', textAlign: 'left', transition: 'all 0.2s',
      boxShadow: selected ? `0 0 12px rgba(${rgb},0.35)` : 'none',
      width: '100%',
    }}>
      {children}
    </button>
  );
}

export default function GameSetupPage({ onStart, onBack }) {
  const [gridSize, setGridSize] = useState(5);
  const [mode, setMode] = useState('classic');
  const [vsAI, setVsAI] = useState(true);
  const [difficulty, setDifficulty] = useState('medium');
  const [p1Name, setP1Name] = useState('');
  const [p2Name, setP2Name] = useState('');

  function handleStart() {
    audio.unlock();
    audio.click();
    if (!audio.musicMuted) audio.startMusic();
    onStart({
      gridSize, mode, vsAI, aiDifficulty: difficulty,
      playerNames: [
        p1Name.trim() || 'PLAYER 1',
        vsAI ? `AI: ${DIFF_OPTS.find(d => d.id === difficulty).label}` : (p2Name.trim() || 'PLAYER 2'),
      ],
    });
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <nav style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '1rem 1.25rem', borderBottom: '1px solid #0f0f2a', flexShrink: 0 }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← BACK</button>
        <span style={{ fontFamily: 'Orbitron', fontSize: '0.65rem', color: '#5060a0', letterSpacing: '0.15em' }}>GAME SETUP</span>
      </nav>

      <div style={{ flex: 1, padding: '1.25rem 1rem 2rem', display: 'flex', justifyContent: 'center', overflowY: 'auto' }}>
        <div style={{ width: '100%', maxWidth: '640px', display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>

          {/* Grid Size */}
          <section>
            <h3 style={{ fontFamily: 'Orbitron', fontSize: '0.6rem', color: '#5060a0', letterSpacing: '0.2em', marginBottom: '0.75rem' }}>GRID SIZE</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.6rem' }}>
              {GRID_OPTS.map(g => (
                <OptionCard key={g.size} selected={gridSize === g.size} onClick={() => setGridSize(g.size)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontFamily: 'Orbitron', fontSize: '1rem', color: gridSize === g.size ? '#00f5ff' : '#c0c0ff', fontWeight: 700 }}>{g.label}</div>
                      <div style={{ fontFamily: 'Orbitron', fontSize: '0.5rem', color: gridSize === g.size ? '#00f5ff' : '#303060', letterSpacing: '0.1em', marginTop: '0.15rem' }}>{g.desc}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '0.65rem', color: '#404070' }}>{g.boxes} boxes</div>
                      <div style={{ fontSize: '0.6rem', color: '#252550' }}>{g.time}</div>
                    </div>
                  </div>
                </OptionCard>
              ))}
            </div>
          </section>

          {/* Game Mode */}
          <section>
            <h3 style={{ fontFamily: 'Orbitron', fontSize: '0.6rem', color: '#5060a0', letterSpacing: '0.2em', marginBottom: '0.75rem' }}>GAME MODE</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {MODE_OPTS.map(m => (
                <OptionCard key={m.id} selected={mode === m.id} onClick={() => setMode(m.id)} color={m.color}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
                    <span style={{ fontSize: '1.3rem', minWidth: '28px', textAlign: 'center' }}>{m.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: 'Orbitron', fontSize: '0.65rem', color: mode === m.id ? m.color : '#c0c0ff', letterSpacing: '0.08em' }}>{m.label}</div>
                      <div style={{ fontSize: '0.7rem', color: '#404070', marginTop: '0.15rem' }}>{m.desc}</div>
                    </div>
                    {mode === m.id && <span className="badge" style={{ background: `${m.color}20`, color: m.color, border: `1px solid ${m.color}50`, fontSize: '0.48rem', flexShrink: 0 }}>ACTIVE</span>}
                  </div>
                </OptionCard>
              ))}
            </div>
          </section>

          {/* Opponent */}
          <section>
            <h3 style={{ fontFamily: 'Orbitron', fontSize: '0.6rem', color: '#5060a0', letterSpacing: '0.2em', marginBottom: '0.75rem' }}>OPPONENT</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginBottom: '0.75rem' }}>
              <OptionCard selected={vsAI} onClick={() => setVsAI(true)}>
                <div style={{ fontFamily: 'Orbitron', fontSize: '0.65rem', color: vsAI ? '#00f5ff' : '#c0c0ff' }}>🤖 VS AI</div>
                <div style={{ fontSize: '0.65rem', color: '#404070', marginTop: '0.25rem' }}>Fight the machine</div>
              </OptionCard>
              <OptionCard selected={!vsAI} onClick={() => setVsAI(false)}>
                <div style={{ fontFamily: 'Orbitron', fontSize: '0.65rem', color: !vsAI ? '#00f5ff' : '#c0c0ff' }}>👥 2P LOCAL</div>
                <div style={{ fontSize: '0.65rem', color: '#404070', marginTop: '0.25rem' }}>Same device</div>
              </OptionCard>
            </div>

            {vsAI && (
              <div style={{ animation: 'fade-in 0.3s ease both' }}>
                <div style={{ fontFamily: 'Orbitron', fontSize: '0.55rem', color: '#303060', letterSpacing: '0.15em', marginBottom: '0.6rem' }}>AI DIFFICULTY</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {DIFF_OPTS.map(d => (
                    <OptionCard key={d.id} selected={difficulty === d.id} onClick={() => setDifficulty(d.id)} color={d.color}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <span style={{ color: d.color, fontSize: '1.1rem' }}>{d.icon}</span>
                        <div>
                          <div style={{ fontFamily: 'Orbitron', fontSize: '0.62rem', color: difficulty === d.id ? d.color : '#c0c0ff', letterSpacing: '0.08em' }}>{d.label}</div>
                          <div style={{ fontSize: '0.68rem', color: '#404070' }}>{d.desc}</div>
                        </div>
                      </div>
                    </OptionCard>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Player Names */}
          <section>
            <h3 style={{ fontFamily: 'Orbitron', fontSize: '0.6rem', color: '#5060a0', letterSpacing: '0.2em', marginBottom: '0.75rem' }}>CALL SIGNS (OPTIONAL)</h3>
            <div style={{ display: 'grid', gridTemplateColumns: vsAI ? '1fr' : '1fr 1fr', gap: '0.75rem' }}>
              {[
                { val: p1Name, set: setP1Name, placeholder: 'PLAYER 1', color: '#00f5ff', label: 'P1 NAME' },
                ...(!vsAI ? [{ val: p2Name, set: setP2Name, placeholder: 'PLAYER 2', color: '#ff0055', label: 'P2 NAME' }] : []),
              ].map((p, i) => (
                <div key={i}>
                  <div style={{ fontSize: '0.58rem', color: p.color, fontFamily: 'Orbitron', letterSpacing: '0.1em', marginBottom: '0.35rem' }}>{p.label}</div>
                  <input
                    value={p.val} onChange={e => p.set(e.target.value.toUpperCase())}
                    maxLength={16} placeholder={p.placeholder}
                    style={{ width: '100%', background: 'rgba(10,10,31,0.8)', border: `1px solid ${p.color}40`, borderRadius: '2px', padding: '0.7rem 0.9rem', color: p.color, fontFamily: 'Orbitron', fontSize: '0.75rem', letterSpacing: '0.1em', outline: 'none', WebkitAppearance: 'none' }}
                    onFocus={e => e.target.style.borderColor = p.color}
                    onBlur={e => e.target.style.borderColor = `${p.color}40`}
                  />
                </div>
              ))}
            </div>
          </section>

          <button className="btn btn-primary btn-lg" onClick={handleStart} style={{ width: '100%', fontSize: '0.8rem', padding: '1rem' }}>
            ⚡ INITIALIZE GRID — START GAME
          </button>
        </div>
      </div>
    </div>
  );
}
