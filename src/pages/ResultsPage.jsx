import { useEffect, useRef } from 'react';

const P_COLOR = ['', '#00f5ff', '#ff0055'];
const P_GLOW = ['', 'rgba(0,245,255,0.4)', 'rgba(255,0,85,0.4)'];

function Confetti({ color }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    const particles = Array.from({ length: 60 }, () => ({
      x: Math.random() * canvas.width,
      y: -10 - Math.random() * 100,
      vx: (Math.random() - 0.5) * 3,
      vy: 1 + Math.random() * 3,
      r: 2 + Math.random() * 4,
      c: Math.random() > 0.5 ? color : '#ffffff',
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.2,
    }));

    let frame;
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.spin;
        if (p.y > canvas.height) { p.y = -10; p.x = Math.random() * canvas.width; }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = p.c;
        ctx.shadowColor = p.c;
        ctx.shadowBlur = 6;
        ctx.fillRect(-p.r, -p.r, p.r * 2, p.r * 2);
        ctx.restore();
      });
      frame = requestAnimationFrame(draw);
    }
    draw();
    return () => cancelAnimationFrame(frame);
  }, [color]);

  return <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />;
}

function StatBlock({ label, value, color = '#5060a0' }) {
  return (
    <div style={{
      background: 'rgba(10,10,31,0.6)',
      border: '1px solid #1a1a4a',
      borderRadius: '4px',
      padding: '0.75rem 1rem',
      textAlign: 'center',
    }}>
      <div style={{ fontFamily: 'Orbitron', fontSize: '1.1rem', color, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: '0.65rem', color: '#303060', fontFamily: 'Orbitron', letterSpacing: '0.1em', marginTop: '0.2rem' }}>{label}</div>
    </div>
  );
}

export default function ResultsPage({ state, onPlayAgain, onHome }) {
  const { scores, playerNames, winner, maxCombo, moveCount, totalBoxes, mode, vsAI } = state;
  const isDraw = winner === 'draw';
  const winnerNum = isDraw ? null : winner;
  const winColor = isDraw ? '#ffd700' : P_COLOR[winnerNum];
  const winGlow = isDraw ? 'rgba(255,215,0,0.4)' : P_GLOW[winnerNum];

  const p1Pct = Math.round((scores[1] / totalBoxes) * 100);
  const p2Pct = Math.round((scores[2] / totalBoxes) * 100);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
      {!isDraw && <Confetti color={winColor} />}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem', position: 'relative', zIndex: 1 }}>
        <div style={{ width: '100%', maxWidth: '560px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

          {/* Victor announcement */}
          <div style={{ textAlign: 'center' }}>
            {isDraw ? (
              <>
                <div style={{ fontFamily: 'Orbitron', fontSize: '0.7rem', color: '#ffd700', letterSpacing: '0.3em', marginBottom: '0.5rem' }}>
                  ◆ GRID SYNCHRONIZED ◆
                </div>
                <h1 style={{ fontFamily: 'Orbitron', fontSize: 'clamp(2rem,8vw,4rem)', fontWeight: 900, color: '#ffd700', textShadow: '0 0 20px #ffd700', letterSpacing: '0.1em' }}>
                  DRAW
                </h1>
              </>
            ) : (
              <>
                <div style={{ fontFamily: 'Orbitron', fontSize: '0.7rem', color: winColor, letterSpacing: '0.3em', marginBottom: '0.5rem', animation: 'flicker 2s ease infinite' }}>
                  ◆ SECTOR DOMINANCE ACHIEVED ◆
                </div>
                <h1 style={{
                  fontFamily: 'Orbitron',
                  fontSize: 'clamp(1.5rem,6vw,3rem)',
                  fontWeight: 900,
                  color: winColor,
                  textShadow: `0 0 20px ${winColor}, 0 0 60px ${winGlow}`,
                  letterSpacing: '0.08em',
                  animation: 'float 2s ease infinite',
                }}>
                  {playerNames[winnerNum - 1]}
                </h1>
                <p style={{ fontFamily: 'Orbitron', fontSize: '0.8rem', color: '#5060a0', letterSpacing: '0.2em', marginTop: '0.4rem' }}>
                  WINS THE GRID
                </p>
              </>
            )}
          </div>

          {/* Score cards */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            {[1, 2].map(p => {
              const isWinner = winner === p;
              const color = P_COLOR[p];
              return (
                <div key={p} style={{
                  background: isWinner ? `rgba(${p === 1 ? '0,245,255' : '255,0,85'},0.08)` : 'rgba(10,10,31,0.6)',
                  border: `1px solid ${isWinner ? color : '#1a1a4a'}`,
                  borderRadius: '6px',
                  padding: '1.5rem',
                  textAlign: 'center',
                  boxShadow: isWinner ? `0 0 30px ${P_GLOW[p]}` : 'none',
                  animation: isWinner ? 'pop-in 0.5s cubic-bezier(0.34,1.56,0.64,1) both' : 'fade-in 0.4s ease both',
                }}>
                  <div style={{ fontFamily: 'Orbitron', fontSize: '0.55rem', color, letterSpacing: '0.2em', marginBottom: '0.5rem' }}>
                    P{p} — {p === 1 ? 'CYAN' : 'CRIMSON'} UNIT
                  </div>
                  <div style={{ fontFamily: 'Orbitron', fontSize: '0.9rem', color: isWinner ? color : '#c0c0ff', fontWeight: 700, marginBottom: '0.25rem' }}>
                    {playerNames[p - 1]}
                  </div>
                  <div style={{ fontFamily: 'Orbitron', fontSize: '3rem', color, fontWeight: 900, lineHeight: 1, textShadow: isWinner ? `0 0 20px ${color}` : 'none' }}>
                    {scores[p]}
                  </div>
                  <div style={{ fontSize: '0.65rem', color: '#303060', marginTop: '0.3rem' }}>
                    {p === 1 ? p1Pct : p2Pct}% of sectors
                  </div>
                  {isWinner && (
                    <div style={{ marginTop: '0.75rem' }}>
                      <span className="badge" style={{ background: `${color}20`, color, border: `1px solid ${color}50`, fontSize: '0.6rem' }}>
                        ◆ VICTOR
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Sector bar */}
          <div style={{ background: 'rgba(10,10,31,0.6)', border: '1px solid #1a1a4a', borderRadius: '4px', padding: '1rem' }}>
            <div style={{ fontFamily: 'Orbitron', fontSize: '0.55rem', color: '#303060', letterSpacing: '0.2em', marginBottom: '0.75rem' }}>
              SECTOR CONTROL
            </div>
            <div style={{ height: '8px', borderRadius: '4px', overflow: 'hidden', display: 'flex' }}>
              <div style={{ width: `${p1Pct}%`, background: '#00f5ff', boxShadow: '0 0 8px #00f5ff', transition: 'width 0.8s ease' }} />
              <div style={{ flex: 1, background: '#ff0055', boxShadow: '0 0 8px #ff0055' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.4rem' }}>
              <span style={{ fontSize: '0.65rem', color: '#00f5ff', fontFamily: 'Orbitron' }}>{p1Pct}%</span>
              <span style={{ fontSize: '0.65rem', color: '#ff0055', fontFamily: 'Orbitron' }}>{p2Pct}%</span>
            </div>
          </div>

          {/* Stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
            <StatBlock label="TOTAL MOVES" value={moveCount} />
            <StatBlock label="MAX COMBO" value={maxCombo > 0 ? `×${maxCombo}` : '—'} color="#ffd700" />
            <StatBlock label="SECTORS" value={totalBoxes} />
          </div>

          {/* Mode badge */}
          <div style={{ textAlign: 'center' }}>
            <span className={`badge ${mode === 'blitz' ? 'badge-pink' : mode === 'power' ? 'badge-purple' : 'badge-cyan'}`}>
              {mode.toUpperCase()} MODE {vsAI ? '· VS AI' : '· 2P'}
            </span>
          </div>

          {/* Buttons */}
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button className="btn btn-primary btn-lg" onClick={onPlayAgain} style={{ flex: 1 }}>
              ⚡ PLAY AGAIN
            </button>
            <button className="btn btn-ghost btn-lg" onClick={onHome} style={{ flex: 1 }}>
              ◈ MAIN MENU
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
