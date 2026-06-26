import { useState, useEffect, useRef } from 'react';

const CELL = 80;
const DOT_R = 6;
const LINE_W = 7;
const PAD = 28;
const TAP_TOL = CELL * 0.45; // how close (in svg units) a tap must be to a line to select it

const P_COLOR = ['', '#00f5ff', '#ff0055'];
const P_FILL  = ['', 'rgba(0,245,255,0.12)', 'rgba(255,0,85,0.12)'];

export default function GameBoard({ state, onMove, disabled, voidMode, voidOpponent }) {
  const [hovered, setHovered]     = useState(null);
  const [particles, setParticles] = useState([]);
  const [flashBoxes, setFlashBoxes] = useState([]);
  const prevBoxes  = useRef(state.boxes);
  const particleId = useRef(0);
  const svgRef     = useRef(null);

  const { gridSize, hLines, vLines, boxes, currentPlayer } = state;
  const dots = gridSize;
  const svgW = (dots - 1) * CELL + PAD * 2;

  /* ── Particle / flash effects ── */
  useEffect(() => {
    const newBoxes = [];
    for (let r = 0; r < dots - 1; r++)
      for (let c = 0; c < dots - 1; c++)
        if (boxes[r][c] !== 0 && prevBoxes.current[r][c] === 0)
          newBoxes.push({ row: r, col: c, player: boxes[r][c] });

    if (newBoxes.length > 0) {
      setFlashBoxes(newBoxes.map(b => `${b.row}-${b.col}`));
      setParticles(p => [...p, ...newBoxes.flatMap(b => spawnParticles(b.row, b.col, b.player))]);
      setTimeout(() => setFlashBoxes([]), 600);
    }
    prevBoxes.current = boxes;
  }, [boxes, dots]);

  useEffect(() => {
    if (!particles.length) return;
    const t = setTimeout(() => setParticles([]), 900);
    return () => clearTimeout(t);
  }, [particles]);

  function spawnParticles(row, col, player) {
    const cx = PAD + col * CELL + CELL / 2;
    const cy = PAD + row * CELL + CELL / 2;
    const color = P_COLOR[player];
    return Array.from({ length: 10 }, (_, i) => {
      const angle = (i / 10) * Math.PI * 2;
      const speed = 28 + Math.random() * 38;
      return { id: particleId.current++, x: cx, y: cy, dx: Math.cos(angle) * speed, dy: Math.sin(angle) * speed, color, size: 2 + Math.random() * 3 };
    });
  }

  function dot(r, c) { return { x: PAD + c * CELL, y: PAD + r * CELL }; }

  function isOpponentLine(lineType, row, col) {
    if (!voidMode) return false;
    return (lineType === 'h' ? hLines[row]?.[col] : vLines[row]?.[col]) === voidOpponent;
  }

  /* ── Coordinate-based hit testing ─────────────────────────
     A single handler on the <svg> converts the pointer position to SVG
     coordinates and finds the nearest selectable line. This avoids the
     fragile per-line invisible <rect> hit zones that don't fire reliably
     on some mobile browsers. */

  function clientToSvg(clientX, clientY) {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      sx: (clientX - rect.left) * (svgW / rect.width),
      sy: (clientY - rect.top) * (svgW / rect.height),
    };
  }

  function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  // Returns nearest selectable line {t,r,c} within tolerance, or null.
  function nearestLine(sx, sy) {
    let best = null, bestD = TAP_TOL;

    for (let r = 0; r < dots; r++) {
      for (let c = 0; c < dots - 1; c++) {
        const owner = hLines[r][c];
        const selectable = voidMode ? owner === voidOpponent : owner === 0;
        if (!selectable) continue;
        const { x, y } = dot(r, c);
        const d = segDist(sx, sy, x + DOT_R, y, x + CELL - DOT_R, y);
        if (d < bestD) { bestD = d; best = { t: 'h', r, c }; }
      }
    }
    for (let r = 0; r < dots - 1; r++) {
      for (let c = 0; c < dots; c++) {
        const owner = vLines[r][c];
        const selectable = voidMode ? owner === voidOpponent : owner === 0;
        if (!selectable) continue;
        const { x, y } = dot(r, c);
        const d = segDist(sx, sy, x, y + DOT_R, x, y + CELL - DOT_R);
        if (d < bestD) { bestD = d; best = { t: 'v', r, c }; }
      }
    }
    return best;
  }

  function updateHover(e) {
    if (disabled) { if (hovered) setHovered(null); return; }
    const p = clientToSvg(e.clientX, e.clientY);
    if (!p) return;
    const line = nearestLine(p.sx, p.sy);
    setHovered(line);
  }

  function commitAt(e) {
    if (disabled) return;
    const p = clientToSvg(e.clientX, e.clientY);
    if (!p) return;
    const line = nearestLine(p.sx, p.sy);
    if (line) onMove(line.t, line.r, line.c);
    setHovered(null);
  }

  function clearHover() { if (hovered) setHovered(null); }

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

  const cursor = disabled ? 'default' : 'pointer';

  return (
    <div style={{ position: 'relative', display: 'inline-block', width: '100%', maxWidth: `${svgW}px` }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${svgW} ${svgW}`}
        style={{ width: '100%', display: 'block', userSelect: 'none', touchAction: 'none', cursor }}
        onPointerMove={updateHover}
        onPointerDown={e => { e.preventDefault(); commitAt(e); }}
        onPointerLeave={clearHover}
        onPointerCancel={clearHover}
      >
        <defs>
          <filter id="glow1" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="glow2" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>

        {/* ── Box fills ── */}
        {Array.from({ length: dots - 1 }, (_, r) =>
          Array.from({ length: dots - 1 }, (_, c) => {
            const owner = boxes[r][c];
            if (!owner) return null;
            const key = `${r}-${c}`;
            const isFlash = flashBoxes.includes(key);
            const { x, y } = dot(r, c);
            return (
              <g key={key}>
                <rect
                  x={x + 1} y={y + 1} width={CELL - 2} height={CELL - 2}
                  fill={P_FILL[owner]}
                  stroke={P_COLOR[owner]}
                  strokeWidth={isFlash ? 2 : 0.5}
                  strokeOpacity={isFlash ? 1 : 0.35}
                  filter={isFlash ? (owner === 1 ? 'url(#glow1)' : 'url(#glow2)') : undefined}
                />
                <text
                  x={x + CELL / 2} y={y + CELL / 2 + 5}
                  textAnchor="middle" fill={P_COLOR[owner]}
                  fontSize={11} fontFamily="Orbitron, sans-serif" opacity={0.45}
                >P{owner}</text>
              </g>
            );
          })
        )}

        {/* ── Horizontal lines ── */}
        {Array.from({ length: dots }, (_, r) =>
          Array.from({ length: dots - 1 }, (_, c) => {
            const owner  = hLines[r][c];
            const isHov  = hovered?.t === 'h' && hovered?.r === r && hovered?.c === c;
            const isVoid = isOpponentLine('h', r, c);
            const { x: x1, y: y1 } = dot(r, c);
            const x2 = PAD + (c + 1) * CELL;
            const stroke = isVoid && isHov ? '#ffd700' : lineColor(owner, isHov);
            const showGlow = !!owner || (isVoid && isHov);
            return (
              <g key={`h-${r}-${c}`}>
                {/* Halo (glow) — drawn with geometry, not an SVG filter, so it
                    survives mobile browsers that collapse zero-height bboxes. */}
                {showGlow && (
                  <line
                    x1={x1 + DOT_R} y1={y1} x2={x2 - DOT_R} y2={y1}
                    stroke={stroke} strokeWidth={LINE_W + 9} strokeLinecap="round"
                    opacity={0.22} style={{ pointerEvents: 'none' }}
                  />
                )}
                <line
                  x1={x1 + DOT_R} y1={y1} x2={x2 - DOT_R} y2={y1}
                  stroke={stroke} strokeWidth={LINE_W} strokeLinecap="round"
                  opacity={lineOpacity(owner, isHov)}
                  style={{ transition: 'opacity 0.15s, stroke 0.1s', pointerEvents: 'none' }}
                />
              </g>
            );
          })
        )}

        {/* ── Vertical lines ── */}
        {Array.from({ length: dots - 1 }, (_, r) =>
          Array.from({ length: dots }, (_, c) => {
            const owner  = vLines[r][c];
            const isHov  = hovered?.t === 'v' && hovered?.r === r && hovered?.c === c;
            const isVoid = isOpponentLine('v', r, c);
            const { x: x1, y: y1 } = dot(r, c);
            const y2 = PAD + (r + 1) * CELL;
            const stroke = isVoid && isHov ? '#ffd700' : lineColor(owner, isHov);
            const showGlow = !!owner || (isVoid && isHov);
            return (
              <g key={`v-${r}-${c}`}>
                {showGlow && (
                  <line
                    x1={x1} y1={y1 + DOT_R} x2={x1} y2={y2 - DOT_R}
                    stroke={stroke} strokeWidth={LINE_W + 9} strokeLinecap="round"
                    opacity={0.22} style={{ pointerEvents: 'none' }}
                  />
                )}
                <line
                  x1={x1} y1={y1 + DOT_R} x2={x1} y2={y2 - DOT_R}
                  stroke={stroke} strokeWidth={LINE_W} strokeLinecap="round"
                  opacity={lineOpacity(owner, isHov)}
                  style={{ transition: 'opacity 0.15s, stroke 0.1s', pointerEvents: 'none' }}
                />
              </g>
            );
          })
        )}

        {/* ── Dots ── */}
        {Array.from({ length: dots }, (_, r) =>
          Array.from({ length: dots }, (_, c) => {
            const { x, y } = dot(r, c);
            return (
              <circle key={`d-${r}-${c}`} cx={x} cy={y} r={DOT_R}
                fill="#c0c0ff" opacity={0.9} filter="url(#glow1)"
                style={{ pointerEvents: 'none' }}
              />
            );
          })
        )}

        {/* ── Particles ── */}
        {particles.map(p => (
          <circle key={p.id} cx={p.x} cy={p.y} r={p.size} fill={p.color} opacity={0}
            style={{ animation: 'particle-fly 0.8s ease-out both', pointerEvents: 'none', '--dx': `${p.dx}px`, '--dy': `${p.dy}px` }}
          />
        ))}
      </svg>

      <style>{`
        @keyframes particle-fly {
          0%   { opacity: 1; transform: translate(0, 0); }
          100% { opacity: 0; transform: translate(var(--dx), var(--dy)); }
        }
      `}</style>
    </div>
  );
}
