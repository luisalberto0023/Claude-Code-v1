import { useEffect, useRef } from 'react';

export default function HomePage({ onPlay, onTutorial }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    const dots = [];
    const cols = Math.floor(canvas.width / 80) + 1;
    const rows = Math.floor(canvas.height / 80) + 1;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        dots.push({
          x: c * 80 + 40,
          y: r * 80 + 40,
          pulse: Math.random() * Math.PI * 2,
          speed: 0.02 + Math.random() * 0.02,
        });
      }
    }

    const lines = [];
    for (let i = 0; i < 8; i++) {
      const from = dots[Math.floor(Math.random() * dots.length)];
      const to = dots[Math.floor(Math.random() * dots.length)];
      lines.push({ from, to, progress: 0, speed: 0.003 + Math.random() * 0.004, player: Math.random() > 0.5 ? 1 : 2, delay: i * 0.15 });
    }

    let frame;
    let t = 0;

    function draw() {
      t += 0.016;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      lines.forEach(line => {
        if (t < line.delay) return;
        line.progress = Math.min(1, line.progress + line.speed);
        const tx = line.from.x + (line.to.x - line.from.x) * line.progress;
        const ty = line.from.y + (line.to.y - line.from.y) * line.progress;
        const color = line.player === 1 ? '#00f5ff' : '#ff0055';
        ctx.beginPath();
        ctx.moveTo(line.from.x, line.from.y);
        ctx.lineTo(tx, ty);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.15;
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;

        if (line.progress >= 1) {
          line.progress = 0;
          const idx = Math.floor(Math.random() * dots.length);
          line.from = line.to;
          line.to = dots[idx];
        }
      });

      dots.forEach(d => {
        d.pulse += d.speed;
        const alpha = 0.1 + 0.15 * Math.sin(d.pulse);
        ctx.beginPath();
        ctx.arc(d.x, d.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#00f5ff';
        ctx.globalAlpha = alpha;
        ctx.shadowColor = '#00f5ff';
        ctx.shadowBlur = 6;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
      });

      frame = requestAnimationFrame(draw);
    }

    draw();
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="scanlines" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />

      {/* Header */}
      <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.5rem 2rem', position: 'relative', zIndex: 1, borderBottom: '1px solid #0f0f2a' }}>
        <span style={{ fontFamily: 'Orbitron', fontSize: '0.7rem', color: '#303060', letterSpacing: '0.2em' }}>
          NEXUS GRID v1.0
        </span>
        <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.6rem', color: '#303060', fontFamily: 'Orbitron' }}>
          <span className="badge badge-cyan">DOTS &amp; BOXES</span>
          <span className="badge badge-pink">EVOLVED</span>
        </div>
      </nav>

      {/* Hero */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '4rem 2rem', position: 'relative', zIndex: 1 }}>

        <div style={{ marginBottom: '0.75rem' }}>
          <span className="badge badge-purple" style={{ fontSize: '0.65rem', letterSpacing: '0.2em' }}>
            ◆ CYBERPUNK EDITION ◆
          </span>
        </div>

        <h1
          className="glitch"
          data-text="NEXUS GRID"
          style={{
            fontFamily: 'Orbitron',
            fontSize: 'clamp(3rem, 10vw, 7rem)',
            fontWeight: 900,
            color: '#00f5ff',
            textShadow: '0 0 20px #00f5ff, 0 0 60px rgba(0,245,255,0.4)',
            letterSpacing: '0.08em',
            lineHeight: 1,
            marginBottom: '0.5rem',
          }}
        >
          NEXUS GRID
        </h1>

        <p style={{ fontFamily: 'Orbitron', fontSize: '0.85rem', color: '#ff0055', letterSpacing: '0.3em', textShadow: '0 0 10px #ff0055', marginBottom: '1rem' }}>
          DOTS &amp; BOXES — EVOLVED
        </p>

        <p style={{ color: '#5060a0', fontSize: '0.9rem', maxWidth: '480px', lineHeight: 1.7, marginBottom: '3rem' }}>
          A futuristic reimagining of the classic strategy game. Claim sectors, deploy power-ups,
          and dominate the grid against an AI opponent or a friend.
        </p>

        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center', marginBottom: '3rem' }}>
          <button className="btn btn-primary btn-xl" onClick={onPlay} style={{ minWidth: '200px' }}>
            ⚡ ENTER THE GRID
          </button>
          <button className="btn btn-ghost btn-xl" onClick={onTutorial} style={{ minWidth: '200px' }}>
            ◈ HOW TO PLAY
          </button>
        </div>

        {/* Feature pills */}
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          {[
            { icon: '🤖', label: 'AI OPPONENT', sub: '3 difficulties', badge: 'badge-cyan' },
            { icon: '⚡', label: 'POWER MODE', sub: 'Special abilities', badge: 'badge-purple' },
            { icon: '⏱', label: 'BLITZ MODE', sub: '10s per turn', badge: 'badge-pink' },
            { icon: '👥', label: '2 PLAYERS', sub: 'Local co-op', badge: 'badge-yellow' },
          ].map(f => (
            <div key={f.label} style={{
              background: 'rgba(10,10,31,0.8)',
              border: '1px solid #1a1a4a',
              borderRadius: '4px',
              padding: '0.75rem 1.25rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              backdropFilter: 'blur(10px)',
            }}>
              <span style={{ fontSize: '1.2rem' }}>{f.icon}</span>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontFamily: 'Orbitron', fontSize: '0.6rem', letterSpacing: '0.12em', color: '#c0c0ff' }}>{f.label}</div>
                <div style={{ fontSize: '0.7rem', color: '#404080' }}>{f.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <footer style={{ textAlign: 'center', padding: '1.5rem', color: '#1a1a4a', fontSize: '0.65rem', fontFamily: 'Orbitron', letterSpacing: '0.2em', position: 'relative', zIndex: 1 }}>
        NEXUS GRID © 2026 — DOTS &amp; BOXES REIMAGINED
      </footer>
    </div>
  );
}
