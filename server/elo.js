// Standard ELO. scoreA: 1 = A won, 0 = A lost, 0.5 = draw.
export function expectedScore(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

export function computeElo(ra, rb, scoreA, k = 32) {
  const ea = expectedScore(ra, rb);
  const newA = Math.round(ra + k * (scoreA - ea));
  const newB = Math.round(rb + k * ((1 - scoreA) - (1 - ea)));
  return { newA, newB, deltaA: newA - ra, deltaB: newB - rb };
}
