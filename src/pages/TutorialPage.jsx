import { useState } from 'react';

const STEPS = [
  {
    title: 'THE GRID',
    badge: 'STEP 1 / 6',
    desc: 'The game is played on a grid of dots. Players take turns drawing a single line between two adjacent dots — horizontally or vertically.',
    color: '#00f5ff',
    Demo: DemoGrid,
  },
  {
    title: 'CLAIMING SECTORS',
    badge: 'STEP 2 / 6',
    desc: 'When you draw the 4th side of a square, you claim that sector and score +1 point. You also get a BONUS TURN — keep going!',
    color: '#00f5ff',
    Demo: DemoClaim,
  },
  {
    title: 'STRATEGY',
    badge: 'STEP 3 / 6',
    desc: 'Avoid drawing the 3rd side of any square — you\'re handing your opponent a free capture next turn. Think ahead!',
    color: '#ffd700',
    Demo: DemoStrategy,
  },
  {
    title: 'POWER MODE',
    badge: 'STEP 4 / 6',
    desc: 'Activate special abilities to gain the edge. Each player starts with a set of charges — use them wisely!',
    color: '#bf00ff',
    Demo: DemoPowerUps,
  },
  {
    title: 'BLITZ MODE',
    badge: 'STEP 5 / 6',
    desc: 'Every turn has a 10-second countdown. When time runs out, your turn is skipped! Fast thinking is rewarded.',
    color: '#ff0055',
    Demo: DemoBlitz,
  },
  {
    title: 'VICTORY',
    badge: 'STEP 6 / 6',
    desc: 'When all lines are drawn, the player who claimed the most sectors wins. Dominate the grid!',
    color: '#00ff88',
    Demo: DemoVictory,
  },
];

function MiniSVG({ children, size = 220 }) {
  return (
    <svg viewBox={`0 0 ${size} ${size}`} style={{ width: '100%', maxWidth: `${size}px`, display: 'block', margin: '0 auto' }}>
      {children}
    </svg>
  );
}

function DemoGrid() {
  const dots = 4;
  const cell = 60;
  const pad = 20;
  const size = (dots - 1) * cell + pad * 2;
  return (
    <MiniSVG size={size}>
      {Array.from({ length: dots }, (_, r) =>
        Array.from({ length: dots }, (_, c) => (
          <circle
            key={`${r}-${c}`}
            cx={pad + c * cell} cy={pad + r * cell}
            r={5} fill="#c0c0ff"
            style={{ filter: 'drop-shadow(0 0 4px #c0c0ff)' }}
          />
        ))
      )}
      {[[0,0,0,1,'h',1],[0,0,1,0,'v',2],[1,0,1,1,'h',1]].map(([r,c,r2,c2,t,p], i) => (
        <line key={i}
          x1={pad + c * cell + 6} y1={pad + r * cell + (t==='v'?6:0)}
          x2={pad + c2 * cell + (t==='h'? cell - 6 : 0)} y2={pad + r2 * cell - (t==='v'?6:0)}
          stroke={p===1?'#00f5ff':'#ff0055'} strokeWidth={5} strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 4px ${p===1?'#00f5ff':'#ff0055'})` }}
        />
      ))}
      <text x={size/2} y={size-4} textAnchor="middle" fill="#303060" fontSize={10} fontFamily="Exo 2">
        take turns drawing lines
      </text>
    </MiniSVG>
  );
}

function DemoClaim() {
  const cell = 70; const pad = 20;
  return (
    <MiniSVG size={180}>
      <rect x={pad} y={pad} width={cell} height={cell} fill="rgba(0,245,255,0.15)" stroke="#00f5ff" strokeWidth={1} strokeOpacity={0.4} />
      {[[pad,pad,pad+cell,pad,'#00f5ff'],[pad,pad+cell,pad+cell,pad+cell,'#ff0055'],[pad,pad,pad,pad+cell,'#00f5ff']].map(([x1,y1,x2,y2,c],i)=>(
        <line key={i} x1={x1+5} y1={y1} x2={x2-(x1===x2?0:5)} y2={y2} stroke={c} strokeWidth={6} strokeLinecap="round" style={{filter:`drop-shadow(0 0 4px ${c})`}} />
      ))}
      <line x1={pad+cell} y1={pad+8} x2={pad+cell} y2={pad+cell-8} stroke="#ffd700" strokeWidth={6} strokeLinecap="round" strokeDasharray="4 2"
        style={{filter:'drop-shadow(0 0 6px #ffd700)', animation:'dash-draw 0.8s ease infinite'}} />
      {[pad,pad,pad+cell,pad,pad,pad+cell,pad+cell,pad+cell].reduce((a,_,i,arr)=>i%2===0?[...a,{x:arr[i],y:arr[i+1]}]:a,[]).map((d,i)=>(
        <circle key={i} cx={d.x} cy={d.y} r={5} fill="#c0c0ff" style={{filter:'drop-shadow(0 0 3px #c0c0ff)'}} />
      ))}
      <text x={90} y={130} textAnchor="middle" fill="#ffd700" fontSize={10} fontFamily="Orbitron" style={{filter:'drop-shadow(0 0 4px #ffd700)'}}>+1 BONUS TURN</text>
      <style>{`@keyframes dash-draw{0%{opacity:0.3}50%{opacity:1}100%{opacity:0.3}}`}</style>
    </MiniSVG>
  );
}

function DemoStrategy() {
  const cell = 70; const pad = 20;
  return (
    <MiniSVG size={180}>
      <rect x={pad} y={pad} width={cell} height={cell} fill="rgba(255,0,85,0.08)" stroke="#ff0055" strokeWidth={0.5} strokeOpacity={0.3} />
      {[[pad,pad,pad+cell,pad,'#00f5ff'],[pad,pad,pad,pad+cell,'#00f5ff'],[pad,pad+cell,pad+cell,pad+cell,'#ff0055']].map(([x1,y1,x2,y2,c],i)=>(
        <line key={i} x1={x1+(x1===x2?0:5)} y1={y1+(x1===x2?5:0)} x2={x2-(x1===x2?0:5)} y2={y2-(x1===x2?5:0)} stroke={c} strokeWidth={6} strokeLinecap="round" style={{filter:`drop-shadow(0 0 4px ${c})`}} />
      ))}
      <line x1={pad+cell+5} y1={pad+5} x2={pad+cell+5} y2={pad+cell-5} stroke="#ff0055" strokeWidth={6} strokeLinecap="round" opacity={0.35} strokeDasharray="5 3" />
      <text x={90} y={130} textAnchor="middle" fill="#ff0055" fontSize={9} fontFamily="Orbitron">⚠ 3RD SIDE = DANGER</text>
      <text x={90} y={148} textAnchor="middle" fill="#303060" fontSize={8} fontFamily="Exo 2">opponent gets free capture!</text>
    </MiniSVG>
  );
}

function DemoPowerUps() {
  const powers = [
    { icon: '⚡', name: 'SURGE', desc: 'Extra move', color: '#00f5ff' },
    { icon: '🌀', name: 'VOID', desc: 'Erase opponent\'s last line', color: '#bf00ff' },
    { icon: '💥', name: 'CASCADE', desc: 'Chain reaction capture', color: '#ffd700' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', width: '100%', maxWidth: '240px', margin: '0 auto' }}>
      {powers.map(p => (
        <div key={p.name} style={{
          background: 'rgba(10,10,31,0.8)',
          border: `1px solid ${p.color}40`,
          borderRadius: '4px',
          padding: '0.6rem 1rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          boxShadow: `0 0 10px ${p.color}20`,
        }}>
          <span style={{ fontSize: '1.2rem' }}>{p.icon}</span>
          <div>
            <div style={{ fontFamily: 'Orbitron', fontSize: '0.6rem', color: p.color, letterSpacing: '0.1em' }}>{p.name}</div>
            <div style={{ fontSize: '0.7rem', color: '#5060a0' }}>{p.desc}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function DemoBlitz() {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        fontFamily: 'Orbitron',
        fontSize: '3.5rem',
        fontWeight: 900,
        color: '#ff0055',
        textShadow: '0 0 20px #ff0055',
        lineHeight: 1,
        marginBottom: '0.5rem',
        animation: 'flicker 1s ease infinite',
      }}>
        07
      </div>
      <div style={{ fontFamily: 'Orbitron', fontSize: '0.65rem', color: '#5060a0', letterSpacing: '0.15em' }}>
        SECONDS REMAINING
      </div>
      <div style={{ marginTop: '1rem', height: '4px', background: '#0a0a1f', borderRadius: '2px', overflow: 'hidden', width: '160px', margin: '1rem auto 0' }}>
        <div style={{
          height: '100%',
          width: '70%',
          background: 'linear-gradient(90deg, #ff0055, #ffd700)',
          borderRadius: '2px',
          boxShadow: '0 0 8px #ff0055',
        }} />
      </div>
      <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#303060' }}>
        Draw a line before time runs out!
      </div>
    </div>
  );
}

function DemoVictory() {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        fontFamily: 'Orbitron',
        fontSize: '1.4rem',
        fontWeight: 900,
        color: '#00ff88',
        textShadow: '0 0 20px #00ff88',
        letterSpacing: '0.1em',
        marginBottom: '1.5rem',
        animation: 'float 2s ease infinite',
      }}>
        VICTORY
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: '2rem' }}>
        {[{ player: 'P1', score: 7, color: '#00f5ff', win: true }, { player: 'P2', score: 4, color: '#ff0055', win: false }].map(p => (
          <div key={p.player} style={{
            background: p.win ? `rgba(0,255,136,0.08)` : 'rgba(10,10,31,0.6)',
            border: `1px solid ${p.win ? '#00ff88' : '#1a1a4a'}`,
            borderRadius: '4px',
            padding: '1rem',
            minWidth: '80px',
            boxShadow: p.win ? '0 0 20px rgba(0,255,136,0.3)' : 'none',
          }}>
            <div style={{ fontFamily: 'Orbitron', fontSize: '0.55rem', color: p.color, letterSpacing: '0.15em', marginBottom: '0.4rem' }}>{p.player}</div>
            <div style={{ fontFamily: 'Orbitron', fontSize: '2rem', color: p.win ? '#00ff88' : p.color, fontWeight: 900 }}>{p.score}</div>
            {p.win && <div style={{ fontSize: '0.6rem', color: '#00ff88', fontFamily: 'Orbitron', marginTop: '0.2rem' }}>WIN</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TutorialPage({ onPlay, onBack }) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const Demo = current.Demo;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}>
      {/* Header */}
      <nav style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '1.25rem 2rem', borderBottom: '1px solid #0f0f2a' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← BACK</button>
        <span style={{ fontFamily: 'Orbitron', fontSize: '0.7rem', color: '#5060a0', letterSpacing: '0.15em' }}>
          HOW TO PLAY
        </span>
      </nav>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem' }}>
        <div style={{ width: '100%', maxWidth: '560px' }}>

          {/* Progress bar */}
          <div style={{ marginBottom: '2rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ fontFamily: 'Orbitron', fontSize: '0.6rem', color: '#303060', letterSpacing: '0.15em' }}>{current.badge}</span>
              <span style={{ fontFamily: 'Orbitron', fontSize: '0.6rem', color: current.color, letterSpacing: '0.1em' }}>{current.title}</span>
            </div>
            <div style={{ height: '2px', background: '#0f0f28', borderRadius: '1px', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: `${((step + 1) / STEPS.length) * 100}%`,
                background: current.color,
                boxShadow: `0 0 6px ${current.color}`,
                transition: 'width 0.3s ease',
              }} />
            </div>
          </div>

          {/* Card */}
          <div className="card fade-in" style={{ borderColor: `${current.color}40`, boxShadow: `inset 0 0 40px ${current.color}08`, minHeight: '400px', display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ fontFamily: 'Orbitron', fontSize: '1.3rem', color: current.color, textShadow: `0 0 12px ${current.color}`, marginBottom: '1.5rem', letterSpacing: '0.08em' }}>
              {current.title}
            </h2>

            <p style={{ color: '#8080c0', lineHeight: 1.8, fontSize: '0.9rem', marginBottom: '2rem' }}>
              {current.desc}
            </p>

            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem 0' }}>
              <Demo />
            </div>
          </div>

          {/* Navigation */}
          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem', justifyContent: 'space-between', alignItems: 'center' }}>
            <button
              className="btn btn-ghost"
              onClick={() => setStep(s => s - 1)}
              disabled={step === 0}
            >
              ← PREV
            </button>

            <div style={{ display: 'flex', gap: '6px' }}>
              {STEPS.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setStep(i)}
                  style={{
                    width: i === step ? '24px' : '8px',
                    height: '8px',
                    borderRadius: '4px',
                    border: 'none',
                    background: i === step ? current.color : '#1a1a4a',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    boxShadow: i === step ? `0 0 6px ${current.color}` : 'none',
                    padding: 0,
                  }}
                />
              ))}
            </div>

            {step < STEPS.length - 1 ? (
              <button className="btn btn-primary" onClick={() => setStep(s => s + 1)}>
                NEXT →
              </button>
            ) : (
              <button className="btn btn-primary" onClick={onPlay}>
                ⚡ PLAY NOW
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
