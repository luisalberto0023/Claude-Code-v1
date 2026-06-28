import { useEffect, useState } from 'react';
import { audio } from '../game/audio.js';
import { fetchLeaderboard } from '../online/account.js';

const insets = {
  paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
  paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)',
};
const medal = (rank) => (rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`);

export default function OnlineLeaderboardPage({ onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    fetchLeaderboard()
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setError(e.message || 'Failed to load.'); });
    return () => { alive = false; };
  }, []);

  const top = data?.top || [];
  const me = data?.me || null;
  const inTop = me && top.some((p, i) => i + 1 === me.rank && p.name === me.name);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', ...insets }}>
      <nav style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '1rem 1.25rem', borderBottom: '1px solid #0f0f2a', flexShrink: 0 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => { audio.click(); onBack(); }}>← BACK</button>
        <span style={{ fontFamily: 'Orbitron', fontSize: '0.65rem', color: '#ffd700', letterSpacing: '0.15em' }}>🏆 LEADERBOARD</span>
      </nav>

      <div style={{ flex: 1, padding: '1.25rem 1rem', display: 'flex', justifyContent: 'center', overflowY: 'auto' }}>
        <div style={{ width: '100%', maxWidth: '520px' }}>
          {error && <div style={{ color: '#ff0055', textAlign: 'center', fontFamily: 'Exo 2', marginTop: '2rem' }}>{error}</div>}
          {!error && !data && <div style={{ color: '#5060a0', textAlign: 'center', fontFamily: 'Orbitron', fontSize: '0.7rem', marginTop: '2rem', letterSpacing: '0.1em' }}>LOADING…</div>}

          {data && top.length === 0 && (
            <div style={{ color: '#5060a0', textAlign: 'center', fontFamily: 'Exo 2', marginTop: '2rem' }}>
              No ranked games played yet. Be the first — play a Ranked match!
            </div>
          )}

          {top.map((p, i) => {
            const rank = i + 1;
            const isMe = me && me.rank === rank && p.name === me.name;
            return <Row key={rank} rank={rank} p={p} highlight={isMe} />;
          })}

          {me && !inTop && (
            <>
              <div style={{ textAlign: 'center', color: '#303060', fontFamily: 'Orbitron', fontSize: '0.7rem', margin: '0.75rem 0' }}>· · ·</div>
              <Row rank={me.rank} p={me} highlight />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ rank, p, highlight }) {
  const color = rank === 1 ? '#ffd700' : '#00f5ff';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '0.75rem',
      padding: '0.7rem 0.9rem', marginBottom: '0.4rem', borderRadius: '4px',
      background: highlight ? 'rgba(0,245,255,0.08)' : 'rgba(10,10,31,0.5)',
      border: `1px solid ${highlight ? '#00f5ff' : '#14143a'}`,
      boxShadow: highlight ? '0 0 12px rgba(0,245,255,0.25)' : 'none',
    }}>
      <div style={{ fontFamily: 'Orbitron', fontSize: '0.85rem', color, minWidth: '36px', textAlign: 'center' }}>{medal(rank)}</div>
      <div style={{ flex: 1, fontFamily: 'Orbitron', fontSize: '0.75rem', color: highlight ? '#00f5ff' : '#c0c0ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {p.name}{highlight ? ' · YOU' : ''}
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: 'Orbitron', fontSize: '0.9rem', color: '#ffd700', fontWeight: 700, lineHeight: 1 }}>{p.rating}</div>
        <div style={{ fontSize: '0.55rem', color: '#5060a0', marginTop: '0.15rem' }}>{p.wins}W · {p.losses}L{p.draws ? ` · ${p.draws}D` : ''}</div>
      </div>
    </div>
  );
}
