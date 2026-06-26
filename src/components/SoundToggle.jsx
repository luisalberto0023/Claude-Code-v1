import { useState } from 'react';
import { audio } from '../game/audio.js';

/* Compact music + SFX mute toggles for the nav bars. */
export default function SoundToggle({ compact = false }) {
  const [musicMuted, setMusicMuted] = useState(audio.musicMuted);
  const [sfxMuted, setSfxMuted] = useState(audio.sfxMuted);

  const btn = (active, label, onClick, title) => (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: 'transparent',
        border: `1px solid ${active ? '#1a1a4a' : '#2a2a6a'}`,
        borderRadius: '4px',
        color: active ? '#303060' : '#00f5ff',
        fontSize: compact ? '0.85rem' : '0.95rem',
        lineHeight: 1,
        padding: compact ? '0.3rem 0.4rem' : '0.35rem 0.5rem',
        cursor: 'pointer',
        transition: 'all 0.15s',
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ display: 'flex', gap: '0.35rem' }}>
      {btn(
        musicMuted, musicMuted ? '🎵̸' : '🎵',
        () => { audio.unlock(); const m = audio.toggleMusic(); setMusicMuted(m); if (!m) audio.startMusic(); },
        'Toggle music',
      )}
      {btn(
        sfxMuted, sfxMuted ? '🔇' : '🔊',
        () => { audio.unlock(); const m = audio.toggleSfx(); setSfxMuted(m); if (!m) audio.click(); },
        'Toggle sound effects',
      )}
    </div>
  );
}
