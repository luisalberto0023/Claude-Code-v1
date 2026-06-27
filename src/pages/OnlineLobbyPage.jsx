import { useState } from 'react';
import { audio } from '../game/audio.js';
import { isOnlineConfigured } from '../online/firebaseConfig.js';
import { createRoom, joinRoom } from '../online/online.js';

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
  const [tab, setTab] = useState('create');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [gridSize, setGridSize] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const configured = isOnlineConfigured();

  async function handleCreate() {
    audio.click();
    setBusy(true); setError('');
    try {
      const c = await createRoom({ gridSize, mode: 'classic', vsAI: false }, name.trim().toUpperCase());
      onStart(c);
    } catch (e) {
      setError(e.message || 'Could not create room.');
      setBusy(false);
    }
  }

  async function handleJoin() {
    audio.click();
    setBusy(true); setError('');
    try {
      const c = await joinRoom(code, name.trim().toUpperCase());
      onStart(c);
    } catch (e) {
      setError(e.message || 'Could not join room.');
      setBusy(false);
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
                Online play needs a free Firebase backend. See <b>ONLINE_MULTIPLAYER.md</b> in the
                repo for the 5-minute setup, then this screen activates.
              </p>
            </div>
          )}

          {/* Tabs */}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {[['create', '➕ CREATE'], ['join', '🔑 JOIN']].map(([id, label]) => (
              <button key={id} onClick={() => { audio.click(); setTab(id); setError(''); }} style={{
                flex: 1, padding: '0.7rem', borderRadius: '4px', cursor: 'pointer',
                fontFamily: 'Orbitron', fontSize: '0.7rem', letterSpacing: '0.1em',
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
            <input
              value={name} onChange={e => setName(e.target.value.toUpperCase())}
              maxLength={16} placeholder="PLAYER"
              style={inputStyle}
            />
          </div>

          {tab === 'create' ? (
            <>
              <div>
                <div style={{ fontSize: '0.58rem', color: '#5060a0', fontFamily: 'Orbitron', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>GRID SIZE</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '0.5rem' }}>
                  {GRID_OPTS.map(g => (
                    <button key={g.size} onClick={() => { audio.click(); setGridSize(g.size); }} style={{
                      padding: '0.6rem 0', borderRadius: '4px', cursor: 'pointer',
                      fontFamily: 'Orbitron', fontSize: '0.7rem',
                      background: gridSize === g.size ? 'rgba(0,245,255,0.08)' : 'rgba(10,10,31,0.5)',
                      border: `1px solid ${gridSize === g.size ? '#00f5ff' : '#1a1a4a'}`,
                      color: gridSize === g.size ? '#00f5ff' : '#8080c0',
                    }}>{g.label}</button>
                  ))}
                </div>
                <div style={{ fontSize: '0.62rem', color: '#404070', marginTop: '0.5rem' }}>Online matches use Classic rules.</div>
              </div>
              <button className="btn btn-primary btn-lg" disabled={!configured || busy} onClick={handleCreate} style={{ width: '100%' }}>
                {busy ? 'CREATING…' : '⚡ CREATE MATCH'}
              </button>
            </>
          ) : (
            <>
              <div>
                <div style={{ fontSize: '0.58rem', color: '#5060a0', fontFamily: 'Orbitron', letterSpacing: '0.1em', marginBottom: '0.35rem' }}>ROOM CODE</div>
                <input
                  value={code} onChange={e => setCode(e.target.value.toUpperCase().slice(0, 4))}
                  maxLength={4} placeholder="ABCD" autoCapitalize="characters"
                  style={{ ...inputStyle, fontSize: '1.6rem', letterSpacing: '0.5em', textAlign: 'center' }}
                />
              </div>
              <button className="btn btn-primary btn-lg" disabled={!configured || busy} onClick={handleJoin} style={{ width: '100%' }}>
                {busy ? 'JOINING…' : '🔑 JOIN MATCH'}
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
