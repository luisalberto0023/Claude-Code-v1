# Notes for Claude sessions

## North star

The goal is an agent that plays ANY game autonomously, including games it
has never seen and has no plugin for. Weigh every change against that: say
how it moves the agent toward an unseen game, or why a game-specific piece is
still worth it (a test bed, or a pattern that will generalise).

## Push every change

The agent is tested on a separate computer that only gets code through
`git pull`. A change that is not on GitHub never reaches a test run, and
"Already up to date" there would be misleading.

- Commit and push every change to `claude/review-game-agent-DGtPg` as soon as
  it is verified. Never leave an edit uncommitted or local-only.
- Before pushing: `npm run check` (UI first-render smoke test, agent checks
  in `tools/check-agent.mjs` such as the outcome names page and backend share
  and the backend token the page sends, plugin contracts, Minesweeper reader,
  simulator, then the backend routes with all input stubbed, including their
  token, Origin and Host refusals), plus `npm run build` if `src/GameAgent.jsx`
  changed. The backend step needs a Python with fastapi, uvicorn and pydantic: the `.venv`
  that start.bat creates on Windows, or `pip install fastapi uvicorn pydantic`
  for the `python3` on PATH elsewhere (a cloud session, say). Backend tests
  belong in `tools/check_backend.py`, never against a running backend: its
  routes move the real mouse and keyboard.
- Every backend route except `GET /health` needs the launch token
  (`X-Agent-Token`), and every page request goes through `backend()` in
  `src/GameAgent.jsx`, which adds it. Never fetch `/api` any other way, never
  add a route that skips the check, and never print, log or commit
  `.agent-token`.
- Stage only the files you changed; never sweep in unrelated uncommitted edits
  already in the working tree. Never force-push.
- After pushing, tell the user the short hash and subject so they can confirm
  it with `git log -1 --oneline` on the test computer. If the agent is running
  there, it needs start.bat restarted — a running backend keeps the old code.

## Local checkouts lag behind GitHub

Cloud sessions push straight to GitHub, so a local checkout can be many
commits behind. Fetch and compare with `origin/claude/review-game-agent-DGtPg`
before trusting local state or running anything.
