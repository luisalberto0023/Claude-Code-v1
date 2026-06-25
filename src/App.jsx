import { useState } from 'react';
import HomePage from './pages/HomePage.jsx';
import TutorialPage from './pages/TutorialPage.jsx';
import GameSetupPage from './pages/GameSetupPage.jsx';
import GamePage from './pages/GamePage.jsx';
import ResultsPage from './pages/ResultsPage.jsx';

export default function App() {
  const [page, setPage] = useState('home');
  const [gameConfig, setGameConfig] = useState(null);
  const [finalState, setFinalState] = useState(null);

  function handleStartGame(config) {
    setGameConfig(config);
    setPage('game');
  }

  function handleGameOver(state) {
    setFinalState(state);
    setPage('results');
  }

  function handlePlayAgain() {
    setPage('game');
    setFinalState(null);
  }

  return (
    <>
      {page === 'home' && (
        <HomePage
          onPlay={() => setPage('setup')}
          onTutorial={() => setPage('tutorial')}
        />
      )}
      {page === 'tutorial' && (
        <TutorialPage
          onPlay={() => setPage('setup')}
          onBack={() => setPage('home')}
        />
      )}
      {page === 'setup' && (
        <GameSetupPage
          onStart={handleStartGame}
          onBack={() => setPage('home')}
        />
      )}
      {page === 'game' && gameConfig && (
        <GamePage
          key={JSON.stringify(gameConfig) + Date.now()}
          config={gameConfig}
          onGameOver={handleGameOver}
          onQuit={() => setPage('home')}
        />
      )}
      {page === 'results' && finalState && (
        <ResultsPage
          state={finalState}
          onPlayAgain={handlePlayAgain}
          onHome={() => setPage('home')}
        />
      )}
    </>
  );
}
