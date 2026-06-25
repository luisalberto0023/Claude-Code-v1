import { useState, useEffect, useRef } from 'react';

const CELL = 80;
const DOT_R = 6;
const LINE_W = 7;
const HIT = 22;
const PAD = 28;

const P_COLOR = ['', '#00f5ff', '#ff0055'];
const P_GLOW = ['', 'rgba(0,245,255,0.8)', 'rgba(255,0,85,0.8)'];
const P_FILL = ['', 'rgba(0,245,255,0.12)', 'rgba(255,0,85,0.12)'];

export default function GameBoard({ state, onMove, disabled, voidMode, voidOpponent }) {
  const [hovered, setHovered] = useState(null);
  const [particles, setParticles] = useState([]);
  const [flashBoxes, setFlashBoxes] = useState([]);
  const prevBoxes = useRef(state.boxes);
  const particleId = useRef(0);

  const { gridSize, hLines, vLines, boxes, currentPlayer } = state;
  const dots = gridSize;
  const svgW = (dots - 1) * CELL + PAD * 2;
  const svgH = svgW;

  useEffect(() => {
    const newBoxes = [];
    for (let r = 0; r < dots - 1; r++) {
      for (let c = 0; c < dots - 1; c++) {
        if (boxes[r][c] !== 0 && prevBoxes.current[r][c] === 0) {
          newBoxes.push({ row: r, col: c, player: boxes[r][c] });
        }
      }
    }
    if (newBoxes.length > 0) {
      setFlashBoxes(newBoxes.map(b => `${b.row}-${b.col}`));
      const newParticles = newBoxes.flatMap(b => spawnParticles(b.row, b.col, b.player));
      setParticles(p => [...p, ...newParticles]);
      setTimeout(() => setFlashBoxes([]), 600);
    }
    prevBoxes.current = boxes;
  }, [boxes, dots]);

  useEffect(() => {
    if (particles.length === 0) return;
    const t = setTimeout(() => setParticles([]), 900);
    return () => clearTimeout(t);
  }, [particles]);

  function spawnParticles(row, col, player) {
    const cx = PAD + col * CELL + CELL / 2;
    const cy = PAD + row * CELL + CELL / 2;
    const color = P_COLOR[player];
    return Array.from({ length: 12 }, (_, i) => {
      const angle = (i / 12) * Math.PI * 2;
      const speed = 30 + Math.random() * 40;
      return {
        id: particleId.current++,
        x: cx, y: cy,
        dx: Math.cos(angle) * speed,
        dy: Math.sin(angle) * speed,
        color,
        size: 2 + Math.random() * 3,
      };
    });
  }

  function dotPos(r, c) {
    return { x: PAD + c * CELL, y: PAD + r * CELL };
  }

  function isOpponentLine(lineType, row, col) {
    if (!voidMode) return false;
    const val = lineType === 'h' ? hLines[row]?.[col] : vLines[row]?.[col];
    return val === voidOpponent;
  }

  function handleClick(lineType, row, col) {
    if (disabled) return;
    if (voidMode) {
      if (isOpponentLine(lineType, row, col)) onMove(lineType, row, col);
      return;
    }
    const taken = lineType === 'h' ? hLines[row]?.[col] : vLines[row]?.[col];
    if (taken !== 0) return;
    onMove(lineType, row, col);
  }

  function lineColor(owner, isHov) {
    if (owner) return P_COLOR[owner];
    if (isHov) return P_COLOR[currentPlayer];
    return '#1a1a4a';
  }

  function lineOpacity(owner, isHov) {
    if (owner) return 1;
    if (isHov) return 0.7;
    return 0.25;
  }

  return (
    <div style={{ position: 'relative', display: 'inline-block', width: '100%', maxWidth: `${svgW}px` }}>
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        style={{ width: '100%', display: 'block', userSelect: 'none' }}
      >
        <defs>
          <filter id="glow1" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="glow2" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Box fills */}
        {Array.from({ length: dots - 1 }, (_, r) =>
          Array.from({ length: dots - 1 }, (_, c) => {
            const owner = boxes[r][c];
            if (!owner) return null;
            const key = `${r}-${c}`;
            const isFlash = flashBoxes.includes(key);
            const { x, y } = dotPos(r, c);
            return (
              <g key={key}>
                <rect
                  x={x + 1} y={y + 1}
                  width={CELL - 2} height={CELL - 2}
                  fill={P_FILL[owner]}
                  stroke={P_COLOR[owner]}
                  strokeWidth={isFlash ? 2 : 0.5}
                  strokeOpacity={isFlash ? 1 : 0.3}
                  opacity={isFlash ? 1 : 0.9}
                  style={{ transition: 'opacity 0.3s' }}
                  filter={isFlash ? (owner === 1 ? 'url(#glow1)' : 'url(#glow2)') : undefined}
                />
                <text
                  x={x + CELL / 2} y={y + CELL / 2 + 5}
                  textAnchor="middle"
                  fill={P_COLOR[owner]}
                  fontSize={11}
                  fontFamily="Orbitron, sans-serif"
                  opacity={0.5}
                >
                  P{owner}
                </text>
              </g>
            );
          })
        )}

        {/* Horizontal lines */}
        {Array.from({ length: dots }, (_, r) =>
          Array.from({ length: dots - 1 }, (_, c) => {
            const owner = hLines[r][c];
            const isHov = hovered?.t === 'h' && hovered?.r === r && hovered?.c === c;
            const isVoidable = isOpponentLine('h', r, c);
            const { x: x1, y: y1 } = dotPos(r, c);
            const { x: x2 } = dotPos(r, c + 1);
            const col = P_COLOR[currentPlayer];

            return (
              <g key={`h-${r}-${c}`}>
                <line
                  x1={x1 + DOT_R} y1={y1} x2={x2 - DOT_R} y2={y1}
                  stroke={isVoidable && isHov ? '#ffd700' : lineColor(owner, isHov)}
                  strokeWidth={LINE_W}
                  strokeLinecap="round"
                  opacity={lineOpacity(owner, isHov)}
                  filter={owner ? (owner === 1 ? 'url(#glow1)' : 'url(#glow2)') : undefined}
                  style={{ transition: 'opacity 0.15s, stroke 0.1s' }}
                />
                {(owner === 0 || (voidMode && isVoidable)) && (
                  <rect
                    x={x1 + DOT_R} y={y1 - HIT / 2}
                    width={CELL - DOT_R * 2} height={HIT}
                    fill="transparent"
                    style={{
                      cursor: disabled ? 'default'
                        : (voidMode && !isVoidable) ? 'not-allowed'
                        : 'pointer',
                    }}
                    onMouseEnter={() => !disabled && setHovered({ t: 'h', r, c })}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => handleClick('h', r, c)}
                  />
                )}
              </g>
            );
          })
        )}

        {/* Vertical lines */}
        {Array.from({ length: dots - 1 }, (_, r) =>
          Array.from({ length: dots }, (_, c) => {
            const owner = vLines[r][c];
            const isHov = hovered?.t === 'v' && hovered?.r === r && hovered?.c === c;
            const isVoidable = isOpponentLine('v', r, c);
            const { x: x1, y: y1 } = dotPos(r, c);
            const { y: y2 } = dotPos(r + 1, c);

            return (
              <g key={`v-${r}-${c}`}>
                <line
                  x1={x1} y1={y1 + DOT_R} x2={x1} y2={y2 - DOT_R}
                  stroke={isVoidable && isHov ? '#ffd700' : lineColor(owner, isHov)}
                  strokeWidth={LINE_W}
                  strokeLinecap="round"
                  opacity={lineOpacity(owner, isHov)}
                  filter={owner ? (owner === 1 ? 'url(#glow1)' : 'url(#glow2)') : undefined}
                  style={{ transition: 'opacity 0.15s, stroke 0.1s' }}
                />
                {(owner === 0 || (voidMode && isVoidable)) && (
                  <rect
                    x={x1 - HIT / 2} y={y1 + DOT_R}
                    width={HIT} height={CELL - DOT_R * 2}
                    fill="transparent"
                    style={{
                      cursor: disabled ? 'default'
                        : (voidMode && !isVoidable) ? 'not-allowed'
                        : 'pointer',
                    }}
                    onMouseEnter={() => !disabled && setHovered({ t: 'v', r, c })}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => handleClick('v', r, c)}
                  />
                )}
              </g>
            );
          })
        )}

        {/* Dots */}
        {Array.from({ length: dots }, (_, r) =>
          Array.from({ length: dots }, (_, c) => {
            const { x, y } = dotPos(r, c);
            return (
              <circle
                key={`d-${r}-${c}`}
                cx={x} cy={y} r={DOT_R}
                fill="#c0c0ff"
                filter="url(#glow1)"
                opacity={0.9}
              />
            );
          })
        )}

        {/* Particles */}
        {particles.map(p => (
          <circle
            key={p.id}
            cx={p.x} cy={p.y} r={p.size}
            fill={p.color}
            opacity={0}
            style={{
              animation: `particle-fly 0.8s ease-out both`,
              '--dx': `${p.dx}px`,
              '--dy': `${p.dy}px`,
            }}
          />
        ))}
      </svg>

      <style>{`
        @keyframes particle-fly {
          0% { opacity:1; transform: translate(0,0); }
          100% { opacity:0; transform: translate(var(--dx), var(--dy)); }
        }
      `}</style>
    </div>
  );
}
