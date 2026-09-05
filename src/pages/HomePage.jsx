import { useEffect, useRef } from 'react';
import { audio } from '../game/audio.js';
import SoundToggle from '../components/SoundToggle.jsx';

export default function HomePage({ onPlay, onTutorial, onOnline }) {
  const canvasRef = useRef(null);

  // The first tap is the gesture browsers require to start audio.
  const handlePlay = () => { audio.unlock(); audio.click(); audio.startMusic(); onPlay(); };
  const handleTutorial = () => { audio.unlock(); audio.click(); audio.startMusic(); onTutorial(); };
  const handleOnline = () => { audio.unlock(); audio.click(); audio.startMusic(); onOnline(); };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const resize = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; };
    resize();
    window.addEventListener('resize', resize);

    const spacing = 70;
    function buildDots() {
      const cols = Math.floor(canvas.width / spacing) + 2;
      const rows = Math.floor(canvas.height / spacing) + 2;
      return Array.from({ length: rows * cols }, (_, i) => ({
        x: (i % cols) * spacing + 20, y: Math.floor(i / cols) * spacing + 20,
        pulse: Math.random() * Math.PI * 2, speed: 0.015 + Math.random() * 0.02,
      }));
    }

    let dots = buildDots();
    window.addEventListener('resize', () => { resize(); dots = buildDots(); });

    const lines = Array.from({ length: 6 }, (_, i) => ({
      from: dots[Math.floor(Math.random() * dots.length)],
      to: dots[Math.floor(Math.random() * dots.length)],
      progress: 0, speed: 0.003 + Math.random() * 0.004,
      player: Math.random() > 0.5 ? 1 : 2, delay: i * 0.2,
    }));

    let frame; let t = 0;
    function draw() {
      t += 0.016;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      lines.forEach(line => {
        if (t < line.delay) return;
        line.progress = Math.min(1, line.progress + line.speed);
        const tx = line.from.x + (line.to.x - line.from.x) * line.progress;
        const ty = line.from.y + (line.to.y - line.from.y) * line.progress;
        const color = line.player === 1 ? '#00f5ff' : '#ff0055';
        ctx.beginPath(); ctx.moveTo(line.from.x, line.from.y); ctx.lineTo(tx, ty);
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.12;
        ctx.shadowColor = color; ctx.shadowBlur = 6; ctx.stroke();
        ctx.globalAlpha = 1; ctx.shadowBlur = 0;
        if (line.progress >= 1) { line.progress = 0; line.from = line.to; line.to = dots[Math.floor(Math.random() * dots.length)]; }
      });

      dots.forEach(d => {
        d.pulse += d.speed;
        const alpha = 0.08 + 0.12 * Math.sin(d.pulse);
        ctx.beginPath(); ctx.arc(d.x, d.y, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#00f5ff'; ctx.globalAlpha = alpha;
        ctx.shadowColor = '#00f5ff'; ctx.shadowBlur = 5; ctx.fill();
        ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      });

      frame = requestAnimationFrame(draw);
    }
    draw();
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', resize); };
  }, []);

  return (
    <div className="scanlines" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />

      <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', position: 'relative', zIndex: 1, borderBottom: '1px solid #0a0a20' }}>
        <span style={{ fontFamily: 'Orbitron', fontSize: '0.6rem', color: '#252550', letterSpacing: '0.2em' }}>NEXUS GRID v1.0</span>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span className="badge badge-cyan" style={{ fontSize: '0.55rem' }}>DOTS &amp; BOXES</span>
          <SoundToggle />
        </div>
      </nav>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 'clamp(2rem,8vh,5rem) 1.25rem', position: 'relative', zIndex: 1 }}>

        <div style={{ marginBottom: '0.75rem' }}>
          <span className="badge badge-purple" style={{ fontSize: '0.6rem', letterSpacing: '0.18em' }}>◆ CYBERPUNK EDITION ◆</span>
        </div>

        <h1
          className="glitch" data-text="NEXUS GRID"
          style={{ fontFamily: 'Orbitron', fontSize: 'clamp(2.2rem,10vw,6.5rem)', fontWeight: 900, color: '#00f5ff', textShadow: '0 0 18px #00f5ff, 0 0 50px rgba(0,245,255,0.35)', letterSpacing: '0.06em', lineHeight: 1, marginBottom: '0.4rem' }}
        >
          NEXUS GRID
        </h1>

        <p style={{ fontFamily: 'Orbitron', fontSize: 'clamp(0.55rem,2.5vw,0.85rem)', color: '#ff0055', letterSpacing: '0.25em', textShadow: '0 0 10px #ff0055', marginBottom: '0.75rem' }}>
          DOTS &amp; BOXES — EVOLVED
        </p>

        <p style={{ color: '#404080', fontSize: 'clamp(0.8rem,2.5vw,0.9rem)', maxWidth: '420px', lineHeight: 1.7, marginBottom: 'clamp(1.5rem,5vh,3rem)' }}>
          A futuristic reimagining of the classic strategy game. Claim sectors, deploy power-ups, and dominate the grid.
        </p>

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center', marginBottom: 'clamp(1.5rem,5vh,3rem)', width: '100%', maxWidth: '400px' }}>
          <button className="btn btn-primary btn-xl" onClick={handlePlay} style={{ flex: '1 1 160px' }}>
            ⚡ PLAY NOW
          </button>
          <button className="btn btn-ghost btn-xl" onClick={handleTutorial} style={{ flex: '1 1 160px' }}>
            ◈ HOW TO PLAY
          </button>
          {typeof location !== 'undefined' && location.protocol !== 'file:' && (
            <button className="btn btn-secondary btn-xl" onClick={handleOnline} style={{ flex: '1 1 100%' }}>
              🌐 PLAY ONLINE
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          {[
            { icon: '🤖', label: 'AI OPPONENT' },
            { icon: '⚡', label: 'POWER MODE' },
            { icon: '⏱', label: 'BLITZ MODE' },
            { icon: '👥', label: '2 PLAYERS' },
          ].map(f => (
            <div key={f.label} style={{ background: 'rgba(10,10,31,0.75)', border: '1px solid #1a1a4a', borderRadius: '4px', padding: '0.5rem 0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem', backdropFilter: 'blur(8px)' }}>
              <span style={{ fontSize: '1rem' }}>{f.icon}</span>
              <span style={{ fontFamily: 'Orbitron', fontSize: '0.55rem', letterSpacing: '0.1em', color: '#8080c0' }}>{f.label}</span>
            </div>
          ))}
        </div>
      </div>

      <footer style={{ textAlign: 'center', padding: '1rem', color: '#181838', fontSize: '0.55rem', fontFamily: 'Orbitron', letterSpacing: '0.18em', position: 'relative', zIndex: 1 }}>
        NEXUS GRID © 2026 · BUILD {__BUILD_ID__}
      </footer>
    </div>
  );
}
