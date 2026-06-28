import { useState } from 'react';
import { audio } from '../game/audio.js';
import { isOnlineConfigured } from '../online/serverConfig.js';
import { createPrivate, joinByCode, quickMatch } from '../online/online.js';

const GRID_OPTS = [
  { size: 4, label: '3×3' },
  { size: 5, label: '4×4' },
  { size: 6, label: '5×5' },
  { size: 7, label: '6×6' },
];

const insets = {
  paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
  paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)',
};

export default function OnlineLobbyPage({ onStart, onBack }) {
  const [tab, setTab] = useState('quick');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [gridSize, setGridSize] = useState(5);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const configured = isOnlineConfigured();

  async function run(label, fn) {
    audio.click();
    setBusy(label); setError('');
    try {
      const room = await fn();
      onStart(room);
    } catch (e) {
      setError(e?.message || 'Something went wrong.');
      setBusy('');
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', ...insets }}>
      <nav style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '1rem 1.25rem', borderBottom: '1px solid #0f0f2a', flexShrink: 0 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => { audio.click(); onBack(); }}>← BACK</button>
        <span style={{ fontFamily: 'Orbitron', fontSize: '0.65rem', color: '#5060a0', letterSpacing: '0.15em' }}>PLAY ONLINE</span>
      </nav>

      <div style={{ flex: 1, padding: '1.5rem 1rem', display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: '460px', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

          {!configured && (
            <div className="card card-pink" style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'Orbitron', fontSize: '0.7rem', color: '#ff0055', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>⚠ ONLINE NOT CONFIGURED</div>
              <p style={{ fontSize: '0.8rem', color: '#8080c0', lineHeight: 1.6 }}>
                Deploy the game server and set its URL in <b>src/online/serverConfig.js</b>.
                See <b>ONLINE_MULTIPLAYER.md</b> for the steps.
              </p>
            </div>
          )}

          {/* Tabs */}
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {[['quick', '⚡ QUICK'], ['create', '➕ CREATE'], ['join', '🔑 JOIN']].map(([id, label]) => (
              <button key={id} onClick={() => { audio.click(); setTab(id); setError(''); }} style={{
                flex: 1, padding: '0.65rem 0.4rem', borderRadius: '4px', cursor: 'pointer',
                fontFamily: 'Orbitron', fontSize: '0.62rem', letterSpacing: '0.06em',
                background: tab === id ? 'rgba(0,245,255,0.08)' : 'rgba(10,10,31,0.5)',
                border: `1px solid ${tab === id ? '#00f5ff' : '#1a1a4a'}`,
                color: tab === id ? '#00f5ff' : '#8080c0',
                boxShadow: tab === id ? '0 0 12px rgba(0,245,255,0.3)' : 'none',
              }}>{label}</button>
            ))}
          </div>

          {/* Call sign */}
          <div>
            <div style={{ fontSize: '0.58rem', color: '#00f5ff', fontFamily: 'Orbitron', letterSpacing: '0.1em', marginBottom: '0.35rem' }}>YOUR CALL SIGN</div>
            <input value={name} onChange={e => setName(e.target.value.toUpperCase())} maxLength={16} placeholder="PLAYER" style={inputStyle} />
          </div>

          {tab === 'quick' && (
            <>
              <p style={{ fontSize: '0.78rem', color: '#8080c0', lineHeight: 1.6 }}>
                Get matched with another player who's looking for a game right now. Standard 4×4 grid, Classic rules.
              </p>
              <button className="btn btn-primary btn-lg" disabled={!configured || !!busy} onClick={() => run('quick', () => quickMatch(name.trim().toUpperCase()))} style={{ width: '100%' }}>
                {busy === 'quick' ? 'SEARCHING…' : '⚡ FIND OPPONENT'}
              </button>
            </>
          )}

          {tab === 'create' && (
            <>
              <div>
                <div style={{ fontSize: '0.58rem', color: '#5060a0', fontFamily: 'Orbitron', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>GRID SIZE</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '0.5rem' }}>
                  {GRID_OPTS.map(g => (
                    <button key={g.size} onClick={() => { audio.click(); setGridSize(g.size); }} style={{
                      padding: '0.6rem 0', borderRadius: '4px', cursor: 'pointer', fontFamily: 'Orbitron', fontSize: '0.7rem',
                      background: gridSize === g.size ? 'rgba(0,245,255,0.08)' : 'rgba(10,10,31,0.5)',
                      border: `1px solid ${gridSize === g.size ? '#00f5ff' : '#1a1a4a'}`,
                      color: gridSize === g.size ? '#00f5ff' : '#8080c0',
                    }}>{g.label}</button>
                  ))}
                </div>
                <div style={{ fontSize: '0.62rem', color: '#404070', marginTop: '0.5rem' }}>Classic rules. You'll get a code to share.</div>
              </div>
              <button className="btn btn-primary btn-lg" disabled={!configured || !!busy} onClick={() => run('create', () => createPrivate({ gridSize }, name.trim().toUpperCase()))} style={{ width: '100%' }}>
                {busy === 'create' ? 'CREATING…' : '➕ CREATE MATCH'}
              </button>
            </>
          )}

          {tab === 'join' && (
            <>
              <div>
                <div style={{ fontSize: '0.58rem', color: '#5060a0', fontFamily: 'Orbitron', letterSpacing: '0.1em', marginBottom: '0.35rem' }}>ROOM CODE</div>
                <input value={code} onChange={e => setCode(e.target.value.toUpperCase().slice(0, 4))} maxLength={4} placeholder="ABCD" autoCapitalize="characters"
                  style={{ ...inputStyle, fontSize: '1.6rem', letterSpacing: '0.5em', textAlign: 'center' }} />
              </div>
              <button className="btn btn-primary btn-lg" disabled={!configured || !!busy} onClick={() => run('join', () => joinByCode(code, name.trim().toUpperCase()))} style={{ width: '100%' }}>
                {busy === 'join' ? 'JOINING…' : '🔑 JOIN MATCH'}
              </button>
            </>
          )}

          {error && <div style={{ color: '#ff0055', fontSize: '0.75rem', textAlign: 'center', fontFamily: 'Exo 2' }}>{error}</div>}
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  width: '100%', background: 'rgba(10,10,31,0.8)', border: '1px solid #1a1a4a',
  borderRadius: '2px', padding: '0.7rem 0.9rem', color: '#00f5ff',
  fontFamily: 'Orbitron', fontSize: '0.9rem', letterSpacing: '0.1em', outline: 'none', WebkitAppearance: 'none',
};
