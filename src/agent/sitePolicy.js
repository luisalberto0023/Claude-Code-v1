// ── Where the agent may play ──────────────────────────────────────────────────
//
// minesweeper.online was the Minesweeper test bed. Its website rules say "it is
// cheating to use any program that can perform clicks on a board" (or help
// solve the game: macros, autoclickers, board analysers), and it keeps public
// rankings that real players compete on. Playing as a guest changes neither.
// Nothing in the agent looked at which site, account or mode it was playing:
// the URL field was stored and never read. So runs risked a ban on the account
// in the browser, and put a bot's results on boards real people play for.
//
// The policy (SETUP.md, "Which games the agent may play"): unattended play only
// on local copies, open-source or self-written games, or sites whose terms allow
// automation; never signed in, never ranked, never multiplayer; an exception for
// one game is explicit and dated. For an agent meant to play any game, games
// nobody has looked at included, that is the one rule that holds for every game
// without a legal review each time.
//
// This module is the page's side of it:
//   - BLOCKED_SITES: sites whose own rules forbid automated play. ▶ Start
//     refuses when the game name, the URL field, the window in front or the
//     window chosen for capture points at one, and a run stops when one comes
//     to the front (the agent's first click there brings it forward). 🔍 Test
//     Solver, which reads a board and names the next move, refuses one too.
//   - The acknowledgement asked once per game (by its memory name) before its
//     first run: single-player; not signed in, or a browser profile of its own;
//     results not posted to public rankings, or the site's terms allow bots; and
//     the date the operator checked the terms. The backend keeps it in the
//     game's memory, and the RUN line names it. It vouches for the site in
//     the URL field when it was given: ▶ Start warns when the URL field now
//     points at another, and the RUN line names both.
//   - Local bench pages, the games under bench/ in this project that the dev
//     server serves at http://localhost:5173/bench/<name>/, need no
//     acknowledgement: they are ours, single-player and ranked nowhere.
//
// None of this reads the screen or moves anything: the window titles come from
// the backend's GET /screen/foreground, which reads the title and nothing else.
// tools/check-site-policy.mjs checks this module and its wiring.

export const LOCAL_MINESWEEPER = "http://localhost:5173/bench/minesweeper/";

// How often a run asks which window is in front: once as it starts, then every
// second. At ▶ Start the window in front is the agent page itself, so a game
// window on a blocked site is first seen here, and the solver can send a batch
// of clicks within a few seconds. Reading a title is cheap for the backend.
export const SITE_WATCH_MS = 1000;

// The longest note on which terms were checked, the earliest date taken as the
// day they were checked, and the longest game name kept with the answers
// (agent_server.py holds the same numbers).
export const ACK_TERMS_MAX = 300;
export const ACK_EARLIEST = "2000-01-01";
export const ACK_NAME_MAX = 200;

/**
 * Sites whose rules forbid what the agent does. Each has the domains it is
 * served from, what its pages' titles look like in a browser window, where its
 * rules say so, and what to play instead. Add a site only with a link to rules
 * that forbid automated play, and the date they were read.
 */
export const BLOCKED_SITES = Object.freeze([
  Object.freeze({
    name: "minesweeper.online",
    domains: Object.freeze(["minesweeper.online"]),
    // Its pages are titled "<page> - Minesweeper Online" ("New game - Minesweeper
    // Online"), and a browser window adds its own name after that. Another site,
    // minesweeperonline.com, puts the same words first ("Minesweeper Online -
    // Play Free Online Minesweeper"), so only the site's name as the last part
    // of a page title counts: after another part (the first pattern), or as the
    // whole page title (the second). The site's pages start out titled
    // "Minesweeper Online" until they name themselves, and a page with no name
    // of its own is "- Minesweeper Online"; after those only the browser's name
    // may follow (in Edge, the tab count and a profile too), and a profile
    // named like minesweeperonline.com's title is taken as that title.
    titles: Object.freeze([
      /\S\s+[-–—|]\s+Minesweeper Online(?=\s*$|\s+[-–—|]\s|\s+and \d+ more pages?\b)/i,
      new RegExp(
        "^\\s*(?:[-–—|]\\s*)?Minesweeper Online(?:\\s+and \\d+ more pages?)?" +
        "(?:\\s+[-–—|]\\s+(?:(?![^-–—|]*Minesweeper)[^-–—|]+\\s+[-–—|]\\s+)?Microsoft\\W{0,3}Edge" +
        "|\\s+[-–—|]\\s+(?:Google Chrome|Chromium|Mozilla Firefox|Firefox|Brave|Opera|Vivaldi)\\b[^-–—|]*)?\\s*$",
        "i"),
    ]),
    rules: "https://minesweeper.online/help/website-rules",
    why: 'its website rules say "it is cheating to use any program that can perform clicks on a board", ' +
      "and it keeps public rankings that real players compete on",
    read: "2026-09-24",
    instead: `the local Minesweeper at ${LOCAL_MINESWEEPER}, which the same reader and solver play ` +
      "(Beginner, Intermediate or Expert, and ?seed= for a board that can be played again)",
  }),
]);

const ADDRESS_WITH_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function parseAddress(value) {
  const text = String(value ?? "").trim();
  if (!text || /\s/.test(text)) return null;
  try {
    return new URL(ADDRESS_WITH_SCHEME.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
}

/** The host an address names ("minesweeper.online/start/3" too), lower case, or null. */
export function hostOf(value) {
  const url = parseAddress(value);
  if (!url || !/^https?:$/.test(url.protocol)) return null;
  return url.hostname.toLowerCase().replace(/\.$/, "") || null;
}

const onDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

// Whether `text` names `domain` or a subdomain of it as a word of its own:
// "play on minesweeper.online" and "es.minesweeper.online" do,
// "notminesweeper.online" and "minesweeper.online.example" do not.
function namesDomain(text, domain) {
  const d = domain.replace(/[.]/g, "\\.");
  // Cut short first: names and window titles are short, and a pattern with a
  // repeated group should not be handed pages of text.
  return new RegExp(`(?:^|[^a-z0-9.-])(?:[a-z0-9-]+\\.)*${d}(?!\\.?[a-z0-9-])`, "i")
    .test(String(text ?? "").slice(0, 2000));
}

const clip = (text, max) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * The first blocked site that `desc` (the game name), `url` (the URL field) or
 * one of `windows` ([{title, where}], where says which window it is, e.g. "the
 * window in front") points at, as {site, where, seen}, or null for none.
 */
export function blockedSite({ desc = "", url = "", windows = [] } = {}) {
  for (const site of BLOCKED_SITES) {
    const host = hostOf(url);
    if ((host && site.domains.some(d => onDomain(host, d))) || site.domains.some(d => namesDomain(url, d))) {
      return { site, where: "the URL field", seen: String(url).trim() };
    }
    if (site.domains.some(d => namesDomain(desc, d))) {
      return { site, where: "the game name", seen: String(desc).trim() };
    }
    for (const w of windows ?? []) {
      const title = String(w?.title ?? "");
      if (!title.trim()) continue;
      if (site.domains.some(d => namesDomain(title, d)) || site.titles.some(re => re.test(title))) {
        return { site, where: w.where ?? "a window", seen: title.trim() };
      }
    }
  }
  return null;
}

/**
 * `failure` (what backendFailure said about a reply), or, when it is the
 * "Not Found" of a backend started before these routes existed, what to do
 * about it: the test PC runs whatever backend start.bat last started, and a pull
 * without a restart leaves the old one answering.
 */
export function olderBackendNote(failure) {
  return /^not found$/i.test(String(failure ?? "").trim())
    ? "the backend is older than this page: close its window and the start.bat window, run start.bat, and reload this tab"
    : failure;
}

/**
 * What the log says about a blocked site: at ▶ Start, or when a run meets one
 * (`running`). `refused` names what did not happen, for a refusal elsewhere
 * (🔍 Test Solver's "Solver test not run").
 */
export function blockedSiteMessage(match, { running = false, refused = "Not started" } = {}) {
  const { site, where, seen } = match;
  const what = `${where}${seen ? ` ("${clip(seen, 120)}")` : ""}`;
  const head = running
    ? `■ Stopped: ${what} is ${site.name}, where the agent must not play`
    : `${refused}: ${what} points at ${site.name}, where the agent must not play`;
  return `${head}: ${site.why} (${site.rules}). A run there can get the account banned and puts a bot's results ` +
    `beside real players'. Play ${site.instead}.`;
}

/**
 * The local bench page `url` is, as {url}, or null when it is not one: an
 * http(s) address on this PC (localhost, 127.0.0.1 or [::1]) whose path is
 * /bench/<name>, which is where the dev server serves the games under bench/.
 */
export function localBench(url) {
  const u = parseAddress(url);
  if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname.toLowerCase())) return null;
  if (!/^\/bench\/[a-z0-9][a-z0-9-]*(\/|$)/i.test(u.pathname)) return null;
  return { url: `${u.origin}${u.pathname}${u.search}` };
}

// ── The acknowledgement ───────────────────────────────────────────────────────

// The answers the dialog offers, and how the RUN line says each.
export const ACK_ACCOUNT = Object.freeze({
  "not-signed-in": "not signed in",
  "dedicated-profile": "a browser profile of its own",
});
export const ACK_RANKINGS = Object.freeze({
  "not-ranked": "results not posted to public rankings",
  "terms-allow-bots": "the site's terms allow bots",
});

// The same answers as the dialog words them, in full.
export const ACK_ACCOUNT_CHOICES = Object.freeze({
  "not-signed-in": "Not signed in to the game or the site.",
  "dedicated-profile": "Played in a browser profile made only for the agent, with none of my accounts or saved logins in it.",
});
export const ACK_RANKINGS_CHOICES = Object.freeze({
  "not-ranked": "Results are not posted to public rankings, leaderboards or high-score tables.",
  "terms-allow-bots": "The game's or site's terms allow bots and automated play.",
});

/** A date as YYYY-MM-DD, on this PC's calendar. */
export function localDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function realDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const has = (table, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key);

/**
 * What is missing or wrong in the dialog's answers, as one sentence, or null
 * when they can be saved. `form` is {singlePlayer, account, rankings,
 * termsCheckedOn, terms}; `today` decides which dates are in the future.
 */
export function ackProblem(form, today = new Date()) {
  if (form?.singlePlayer !== true) {
    return "Confirm the game is single-player: the agent plays alone, never with or against other people.";
  }
  if (!has(ACK_ACCOUNT, form.account)) {
    return "Choose how it is played: not signed in, or in a browser profile made for the agent.";
  }
  if (!has(ACK_RANKINGS, form.rankings)) {
    return "Choose whether results stay off public rankings, or the site's terms allow bots.";
  }
  const date = String(form.termsCheckedOn ?? "");
  if (!realDate(date)) return "Give the date you checked the game's or site's terms.";
  if (date > localDate(today)) return "The date the terms were checked cannot be after today.";
  if (date < ACK_EARLIEST) return `The date the terms were checked cannot be before ${ACK_EARLIEST}.`;
  if (String(form.terms ?? "").trim().length > ACK_TERMS_MAX) {
    return `Keep the note on which terms were checked to ${ACK_TERMS_MAX} characters.`;
  }
  return null;
}

/**
 * The body of POST /memory/<game>/acknowledgement for answers ackProblem
 * accepted. `url` is the URL field; only its host is kept, as the site. The
 * game name only labels a new memory entry, so a longer one than the backend
 * keeps is cut short (by characters, not halves of one) rather than refused.
 */
export function ackBody(form, { gameDesc, url } = {}) {
  const terms = String(form?.terms ?? "").trim();
  return {
    gameDesc: Array.from(String(gameDesc ?? "").trim()).slice(0, ACK_NAME_MAX).join("").trim(),
    singlePlayer: true,
    account: form.account,
    rankings: form.rankings,
    termsCheckedOn: form.termsCheckedOn,
    terms: terms || null,
    site: hostOf(url),
  };
}

/**
 * The acknowledgement stored in a game's memory entry (GET /memory/<game>), or
 * null when there is none or it is not one the dialog could have saved.
 */
export function readAck(entry) {
  const a = entry?.acknowledgement;
  if (!a || typeof a !== "object") return null;
  if (a.singlePlayer !== true || !has(ACK_ACCOUNT, a.account) || !has(ACK_RANKINGS, a.rankings)) return null;
  if (!realDate(a.termsCheckedOn)) return null;
  return {
    singlePlayer: true, account: a.account, rankings: a.rankings, termsCheckedOn: a.termsCheckedOn,
    terms: typeof a.terms === "string" && a.terms.trim() ? a.terms.trim() : null,
    site: typeof a.site === "string" && a.site ? a.site : null,
    acknowledgedAt: typeof a.acknowledgedAt === "string" ? a.acknowledgedAt : null,
  };
}

// Two hosts are one site when they are the same or one is under the other
// ("www.play2048.co" and "play2048.co").
const sameSite = (a, b) => onDomain(a, b) || onDomain(b, a);

/**
 * The answers are kept per game name, and the terms they vouch for are those
 * of the site in the URL field when they were given. When the URL field now
 * points at another site, {checked, now} (both hosts); otherwise null, and
 * null too when either was not given.
 */
export function ackSiteChange(ack, url) {
  const now = hostOf(url);
  const checked = typeof ack?.site === "string" && ack.site ? ack.site : null;
  return now && checked && !sameSite(now, checked) ? { checked, now } : null;
}

/** What the log says at ▶ Start about an ackSiteChange. The run still starts. */
export function ackSiteChangeMessage(change, gameDesc) {
  return `The answers for "${String(gameDesc ?? "").trim()}" were given for ${change.checked}, and the URL field now ` +
    `points at ${change.now}, whose terms were not the ones checked. If ${change.now} forbids bots or ranks ` +
    `results, ■ Stop. To answer for ${change.now}, give the game a name of its own for that site (a new name is ` +
    "asked once), or Clear Memory for this one.";
}

/**
 * What a run's records say about where it plays (run.json's sitePolicy):
 * {kind: "local-bench", url}, or {kind: "acknowledged", …the acknowledgement,
 * playedOn} where playedOn is the host of the URL field this run (null when
 * empty), or null for neither.
 */
export function sitePolicyRecord({ bench = null, ack = null, url = "" } = {}) {
  if (bench) return { kind: "local-bench", url: bench.url };
  if (ack) return { kind: "acknowledged", ...ack, playedOn: hostOf(url) };
  return null;
}

/** The RUN line's words for a sitePolicyRecord. */
export function sitePolicyLabel(policy) {
  if (policy?.kind === "local-bench") return `local bench page ${policy.url ?? ""}`.trim();
  if (policy?.kind === "acknowledged") {
    const when = policy.acknowledgedAt ? ` ${String(policy.acknowledgedAt).slice(0, 10)}` : "";
    const now = typeof policy.playedOn === "string" && policy.playedOn ? policy.playedOn : null;
    const where = policy.site
      ? ` (${policy.site})${now && !sameSite(now, policy.site) ? `, now played on ${now}` : ""}`
      : now ? `, played on ${now}` : "";
    return `acknowledged${when}: single-player, ${ACK_ACCOUNT[policy.account] ?? "?"}, ` +
      `${ACK_RANKINGS[policy.rankings] ?? "?"}, terms checked ${policy.termsCheckedOn ?? "?"}${where}`;
  }
  return "no site acknowledgement";
}
