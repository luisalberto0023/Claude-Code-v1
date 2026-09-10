# Notes for Claude sessions

## Push every change

The agent is tested on a separate computer that only gets code through
`git pull`. A change that is not on GitHub never reaches a test run, and
"Already up to date" there would be misleading.

- Commit and push every change to `claude/review-game-agent-DGtPg` as soon as
  it is verified. Never leave an edit uncommitted or local-only.
- Before pushing: `npm run check` (plugin contracts, Minesweeper reader,
  simulator), plus `npm run build` if `src/GameAgent.jsx` changed.
- Stage only the files you changed; never sweep in unrelated uncommitted edits
  already in the working tree. Never force-push.
- After pushing, tell the user the short hash and subject so they can confirm
  it with `git log -1 --oneline` on the test computer. If the agent is running
  there, it needs start.bat restarted — a running backend keeps the old code.

## Local checkouts lag behind GitHub

Cloud sessions push straight to GitHub, so a local checkout can be many
commits behind. Fetch and compare with `origin/claude/review-game-agent-DGtPg`
before trusting local state or running anything.
