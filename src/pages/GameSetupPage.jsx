import { useState } from 'react';

const GRID_OPTS = [
  { size: 4, label: '3×3', boxes: 9, desc: 'QUICK SKIRMISH', time: '~5 min' },
  { size: 5, label: '4×4', boxes: 16, desc: 'STANDARD BATTLE', time: '~10 min' },
  { size: 6, label: '5×5', boxes: 25, desc: 'EXTENDED WAR', time: '~20 min' },
  { size: 7, label: '6×6', boxes: 36, desc: 'FULL CAMPAIGN', time: '~35 min' },
];

const MODE_OPTS = [
  { id: 'classic', label: 'CLASSIC', icon: '◈', desc: 'Standard rules, no time limit. Pure strategy.', color: '#00f5ff' },
  { id: 'blitz', label: 'BLITZ', icon: '⚡', desc: '10 seconds per turn. Think fast or lose your move.', color: '#ff0055' },
  { id: 'power', label: 'POWER MODE', icon: '💥', desc: 'Unlock special abilities: Surge, Void & Cascade.', color: '#bf00ff' },
];

const DIFF_OPTS = [
  { id: 'easy', label: 'RECRUIT', icon: '◉', desc: 'AI plays randomly — great for beginners.', color: '#00ff88' },
  { id: 'medium', label: 'OPERATIVE', icon: '◎', desc: 'AI avoids giving free boxes. A real challenge.', color: '#ffd700' },
  { id: 'hard', label: 'NEXUS CORE', icon: '⬡', desc: 'Advanced chain strategy. Ruthless and calculating.', color: '#ff0055' },
];

function OptionCard({ selected, onClick, children, color = '#00f5ff', style = {} }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: selected ? `rgba(${color === '#00f5ff' ? '0,245,255' : color === '#ff0055' ? '255,0,85' : color === '#bf00ff' ? '191,0,255' : '0,255,136'},0.08)` : 'rgba(10,10,31,0.6)',
        border: `1px solid ${selected ? color : '#1a1a4a'}`,
        borderRadius: '4px',
        padding: '1rem',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'all 0.2s',
        boxShadow: selected ? `0 0 12px ${color}40, inset 0 0 20px ${color}08` : 'none',
        ...style,
      }}
    >
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
    onStart({
      gridSize,
      mode,
      vsAI,
      aiDifficulty: difficulty,
      playerNames: [
        p1Name.trim() || 'PLAYER 1',
        vsAI ? `AI: ${DIFF_OPTS.find(d => d.id === difficulty).label}` : (p2Name.trim() || 'PLAYER 2'),
      ],
    });
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <nav style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '1.25rem 2rem', borderBottom: '1px solid #0f0f2a' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← BACK</button>
        <span style={{ fontFamily: 'Orbitron', fontSize: '0.7rem', color: '#5060a0', letterSpacing: '0.15em' }}>
          GAME SETUP
        </span>
      </nav>

      <div style={{ flex: 1, padding: '2rem 1rem', display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: '680px', display: 'flex', flexDirection: 'column', gap: '2rem' }}>

          {/* Grid Size */}
          <section>
            <h3 style={{ fontFamily: 'Orbitron', fontSize: '0.7rem', color: '#5060a0', letterSpacing: '0.2em', marginBottom: '1rem' }}>
              GRID SIZE
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem' }}>
              {GRID_OPTS.map(g => (
                <OptionCard key={g.size} selected={gridSize === g.size} onClick={() => setGridSize(g.size)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontFamily: 'Orbitron', fontSize: '1.1rem', color: gridSize === g.size ? '#00f5ff' : '#c0c0ff', fontWeight: 700 }}>{g.label}</div>
                      <div style={{ fontFamily: 'Orbitron', fontSize: '0.55rem', color: gridSize === g.size ? '#00f5ff' : '#303060', letterSpacing: '0.12em', marginTop: '0.25rem' }}>{g.desc}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '0.7rem', color: '#404080' }}>{g.boxes} boxes</div>
                      <div style={{ fontSize: '0.65rem', color: '#303060' }}>{g.time}</div>
                    </div>
                  </div>
                </OptionCard>
              ))}
            </div>
          </section>

          {/* Game Mode */}
          <section>
            <h3 style={{ fontFamily: 'Orbitron', fontSize: '0.7rem', color: '#5060a0', letterSpacing: '0.2em', marginBottom: '1rem' }}>
              GAME MODE
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {MODE_OPTS.map(m => (
                <OptionCard key={m.id} selected={mode === m.id} onClick={() => setMode(m.id)} color={m.color}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <span style={{ fontSize: '1.4rem', minWidth: '32px', textAlign: 'center' }}>{m.icon}</span>
                    <div>
                      <div style={{ fontFamily: 'Orbitron', fontSize: '0.7rem', color: mode === m.id ? m.color : '#c0c0ff', letterSpacing: '0.1em' }}>{m.label}</div>
                      <div style={{ fontSize: '0.75rem', color: '#404070', marginTop: '0.2rem' }}>{m.desc}</div>
                    </div>
                    {mode === m.id && <span className="badge" style={{ marginLeft: 'auto', background: `${m.color}20`, color: m.color, border: `1px solid ${m.color}50`, fontSize: '0.55rem' }}>SELECTED</span>}
                  </div>
                </OptionCard>
              ))}
            </div>
          </section>

          {/* Opponent */}
          <section>
            <h3 style={{ fontFamily: 'Orbitron', fontSize: '0.7rem', color: '#5060a0', letterSpacing: '0.2em', marginBottom: '1rem' }}>
              OPPONENT
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem' }}>
              <OptionCard selected={vsAI} onClick={() => setVsAI(true)}>
                <div style={{ fontFamily: 'Orbitron', fontSize: '0.7rem', color: vsAI ? '#00f5ff' : '#c0c0ff' }}>🤖 VS AI</div>
                <div style={{ fontSize: '0.7rem', color: '#404070', marginTop: '0.3rem' }}>Fight the machine</div>
              </OptionCard>
              <OptionCard selected={!vsAI} onClick={() => setVsAI(false)}>
                <div style={{ fontFamily: 'Orbitron', fontSize: '0.7rem', color: !vsAI ? '#00f5ff' : '#c0c0ff' }}>👥 2 PLAYERS</div>
                <div style={{ fontSize: '0.7rem', color: '#404070', marginTop: '0.3rem' }}>Same device, local</div>
              </OptionCard>
            </div>

            {vsAI && (
              <div style={{ animation: 'fade-in 0.3s ease both' }}>
                <div style={{ fontFamily: 'Orbitron', fontSize: '0.6rem', color: '#404070', letterSpacing: '0.15em', marginBottom: '0.75rem' }}>AI DIFFICULTY</div>
                <div style={{ display: 'flex', gap: '0.6rem', flexDirection: 'column' }}>
                  {DIFF_OPTS.map(d => (
                    <OptionCard key={d.id} selected={difficulty === d.id} onClick={() => setDifficulty(d.id)} color={d.color}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <span style={{ color: d.color, fontSize: '1.1rem' }}>{d.icon}</span>
                        <div>
                          <div style={{ fontFamily: 'Orbitron', fontSize: '0.65rem', color: difficulty === d.id ? d.color : '#c0c0ff', letterSpacing: '0.1em' }}>{d.label}</div>
                          <div style={{ fontSize: '0.7rem', color: '#404070' }}>{d.desc}</div>
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
            <h3 style={{ fontFamily: 'Orbitron', fontSize: '0.7rem', color: '#5060a0', letterSpacing: '0.2em', marginBottom: '1rem' }}>
              CALL SIGNS (OPTIONAL)
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              {[
                { val: p1Name, set: setP1Name, placeholder: 'PLAYER 1', color: '#00f5ff' },
                ...(!vsAI ? [{ val: p2Name, set: setP2Name, placeholder: 'PLAYER 2', color: '#ff0055' }] : []),
              ].map((p, i) => (
                <div key={i}>
                  <div style={{ fontSize: '0.65rem', color: p.color, fontFamily: 'Orbitron', letterSpacing: '0.1em', marginBottom: '0.4rem' }}>
                    P{i + 1} NAME
                  </div>
                  <input
                    value={p.val}
                    onChange={e => p.set(e.target.value.toUpperCase())}
                    maxLength={16}
                    placeholder={p.placeholder}
                    style={{
                      width: '100%',
                      background: 'rgba(10,10,31,0.8)',
                      border: `1px solid ${p.color}40`,
                      borderRadius: '2px',
                      padding: '0.6rem 0.8rem',
                      color: p.color,
                      fontFamily: 'Orbitron',
                      fontSize: '0.75rem',
                      letterSpacing: '0.1em',
                      outline: 'none',
                    }}
                    onFocus={e => e.target.style.borderColor = p.color}
                    onBlur={e => e.target.style.borderColor = `${p.color}40`}
                  />
                </div>
              ))}
            </div>
          </section>

          {/* Start */}
          <button className="btn btn-primary btn-xl" onClick={handleStart} style={{ width: '100%', fontSize: '0.9rem' }}>
            ⚡ INITIALIZE GRID — START GAME
          </button>
        </div>
      </div>
    </div>
  );
}
