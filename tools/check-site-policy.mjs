#!/usr/bin/env node
// Check where the agent may play: the sites it refuses, the local bench pages it
// may play without asking, and the questions asked once before a game's first
// run.
//
//   node tools/check-site-policy.mjs
//
// minesweeper.online was the Minesweeper test bed, and its rules call any
// program that clicks on a board cheating. Nothing looked at which site was
// being played: the URL field was stored and never read. So this checks, against
// src/agent/sitePolicy.js and the code that uses it:
//   - the denylist matcher finds minesweeper.online in an address, a game name
//     or a browser window's title, and does not mistake other sites for it
//     (minesweeperonline.com, a look-alike host, the local bench page)
//   - a local bench page is recognised by its address on this PC, and nothing
//     else is
//   - the questions cannot be saved half answered, with a date in the future or
//     not a date at all, and what is saved reads back; the backend refuses the
//     same things with the same limits (tools/check_backend.py checks its side)
//   - the RUN line and run.json say where each run played, and ▶ Start warns
//     when the answers were given for another site than the URL field's now
//   - ▶ Start checks the site before the model check and the run's reset, reads
//     the window in front through the backend and checks its title, opens the
//     questions for a game not yet acknowledged, and a run stops when a blocked
//     site comes to the front (looked for as it starts, then every second);
//     🔍 Test Solver refuses a blocked site too
//   - the questions render, with the answers the backend accepts
//   - SETUP.md and CLAUDE.md state the policy and point Minesweeper at the
//     local page
// tools/check-bench.mjs checks the local Minesweeper itself.

import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const sp = await import(pathToFileURL(path.join(ROOT, "src", "agent", "sitePolicy.js")).href);
const ep = await import(pathToFileURL(path.join(ROOT, "src", "agent", "episodes.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const show = v => JSON.stringify(v);
// Each case is [label, got, test(got)]; the check names the cases that failed.
const cases = (name, list) => {
  const bad = list.filter(([, got, test]) => !test(got)).map(([label, got]) => `${label}: ${show(got)}`);
  check(name, !bad.length, bad.join("; "));
};

// ── Sites whose rules forbid automated play ───────────────────────────────────
console.log("blocked sites");
{
  const site = sp.BLOCKED_SITES.find(s => s.name === "minesweeper.online");
  check("minesweeper.online is on the list, with its rules page, the words that forbid it and when they were read",
    !!site && site.rules === "https://minesweeper.online/help/website-rules" && /cheating/.test(site.why)
      && /^\d{4}-\d{2}-\d{2}$/.test(site.read) && site.instead.includes(sp.LOCAL_MINESWEEPER),
    show(site));
  check("every blocked site links to its rules over https and says what to play instead",
    sp.BLOCKED_SITES.every(s => /^https:\/\//.test(s.rules) && s.why && s.instead && s.domains.length > 0));

  const byUrl = url => sp.blockedSite({ url })?.site.name ?? null;
  cases("the URL field: minesweeper.online and its subdomains, with or without https://", [
    ["https", byUrl("https://minesweeper.online/start/3"), r => r === "minesweeper.online"],
    ["bare", byUrl("minesweeper.online"), r => r === "minesweeper.online"],
    ["no scheme, a path", byUrl("minesweeper.online/game/123"), r => r === "minesweeper.online"],
    ["upper case", byUrl("HTTP://MINESWEEPER.ONLINE/"), r => r === "minesweeper.online"],
    ["a language subdomain", byUrl("https://es.minesweeper.online/game/1"), r => r === "minesweeper.online"],
    ["www", byUrl("www.minesweeper.online"), r => r === "minesweeper.online"],
  ]);
  cases("the URL field: other sites are not minesweeper.online", [
    ["minesweeperonline.com", byUrl("https://minesweeperonline.com/"), r => r === null],
    ["a look-alike host", byUrl("https://minesweeper.online.example.com/"), r => r === null],
    ["a longer name", byUrl("https://notminesweeper.online/"), r => r === null],
    ["the local copy", byUrl(sp.LOCAL_MINESWEEPER), r => r === null],
    ["empty", byUrl(""), r => r === null],
    ["2048", byUrl("https://play2048.co/"), r => r === null],
  ]);

  const byName = desc => sp.blockedSite({ desc })?.site.name ?? null;
  cases("the game name counts when it names the site, not when it only says Minesweeper", [
    ["the site named", byName("Minesweeper on minesweeper.online"), r => r === "minesweeper.online"],
    ["in brackets", byName("Minesweeper (minesweeper.online, Expert)"), r => r === "minesweeper.online"],
    ["Minesweeper", byName("Minesweeper"), r => r === null],
    ["Minesweeper online, in words", byName("minesweeper online"), r => r === null],
  ]);

  const byWindow = title => sp.blockedSite({ windows: [{ title, where: "the window in front" }] });
  cases("a browser window showing minesweeper.online, however the browser names it", [
    ["Chrome", byWindow("New game - Minesweeper Online - Google Chrome"), r => r?.site.name === "minesweeper.online"],
    ["Firefox", byWindow("Expert - Minesweeper Online — Mozilla Firefox"), r => !!r],
    ["Edge, several tabs", byWindow("New game - Minesweeper Online and 3 more pages - Personal - Microsoft Edge"), r => !!r],
    ["the page title alone", byWindow("Website rules - Minesweeper Online"), r => !!r],
    ["the address in the title", byWindow("minesweeper.online/game/5 - Google Chrome"), r => !!r],
    ["says which window", byWindow("New game - Minesweeper Online - Google Chrome"), r => r?.where === "the window in front"],
  ]);
  // The site's pages are titled "Minesweeper Online" until they name
  // themselves, and "- Minesweeper Online" when they have no name of their own.
  // Edge writes its name with a zero-width space in it.
  cases("the site's own name as the whole page title, with only the browser's name after it", [
    ["Chrome", byWindow("Minesweeper Online - Google Chrome"), r => r?.site.name === "minesweeper.online"],
    ["a page with no name", byWindow("- Minesweeper Online - Google Chrome"), r => !!r],
    ["Edge, several tabs", byWindow("Minesweeper Online and 2 more pages - Personal - Microsoft​ Edge"), r => !!r],
    ["Edge, InPrivate", byWindow("Minesweeper Online - [InPrivate] - Microsoft​ Edge"), r => !!r],
    ["Firefox, private", byWindow("Minesweeper Online — Mozilla Firefox Private Browsing"), r => !!r],
    ["the page title alone", byWindow("Minesweeper Online"), r => !!r],
  ]);
  cases("other windows are not minesweeper.online", [
    ["minesweeperonline.com's title", byWindow("Minesweeper Online - Play Free Online Minesweeper - Google Chrome"), r => r === null],
    ["that title alone", byWindow("Minesweeper Online - Play Free Online Minesweeper"), r => r === null],
    ["that title in Edge", byWindow("Minesweeper Online - Play Free Online Minesweeper - Microsoft​ Edge"), r => r === null],
    ["that title in Edge, a profile", byWindow("Minesweeper Online - Play Free Online Minesweeper - Personal - Microsoft​ Edge"), r => r === null],
    ["more words after the name", byWindow("Minesweeper Online Classic - Google Chrome"), r => r === null],
    ["the local copy", byWindow("Minesweeper · Expert · board 42 — game-agent bench - Google Chrome"), r => r === null],
    ["the agent page", byWindow("Game Agent - Google Chrome"), r => r === null],
    ["no title", byWindow(""), r => r === null],
    ["a long title", byWindow("a.".repeat(50000)), r => r === null],
  ]);

  const match = sp.blockedSite({ url: "https://minesweeper.online/start/3" });
  const refusal = sp.blockedSiteMessage(match);
  check("the refusal says what was found, why the site is refused, and what to play instead",
    refusal.startsWith("Not started: the URL field (\"https://minesweeper.online/start/3\") points at minesweeper.online")
      && refusal.includes("https://minesweeper.online/help/website-rules") && /cheating/.test(refusal)
      && /banned/.test(refusal) && refusal.includes(sp.LOCAL_MINESWEEPER),
    refusal);
  cases("a backend too old to have the routes is named as such, and says what to do", [
    ["Not Found", sp.olderBackendNote("Not Found"), r => /older than this page/.test(r) && /start\.bat/.test(r)],
    ["another failure", sp.olderBackendNote("no reply from the backend"), r => r === "no reply from the backend"],
  ]);
  const stopped = sp.blockedSiteMessage(byWindow("New game - Minesweeper Online - Google Chrome"), { running: true });
  check("mid-run, it says the run was stopped", stopped.startsWith("■ Stopped: the window in front") && stopped.includes(sp.LOCAL_MINESWEEPER),
    stopped);
  const notRun = sp.blockedSiteMessage(match, { refused: "Solver test not run" });
  check("elsewhere, it says what was not done", notRun.startsWith("Solver test not run: the URL field") && notRun.includes(sp.LOCAL_MINESWEEPER),
    notRun);
}

// ── The local bench pages ─────────────────────────────────────────────────────
console.log("\nlocal bench pages");
{
  const url = u => sp.localBench(u)?.url ?? null;
  cases("an address of a game under bench/ on this PC is a local bench page", [
    ["the Minesweeper", url(sp.LOCAL_MINESWEEPER), r => r === sp.LOCAL_MINESWEEPER],
    ["no scheme, a seed", url("localhost:5173/bench/minesweeper/?seed=4&level=beginner"),
      r => r === "http://localhost:5173/bench/minesweeper/?seed=4&level=beginner"],
    ["127.0.0.1, no slash", url("http://127.0.0.1:5173/bench/minesweeper"), r => r === "http://127.0.0.1:5173/bench/minesweeper"],
    ["IPv6 loopback", url("http://[::1]:5173/bench/minesweeper/"), r => r === "http://[::1]:5173/bench/minesweeper/"],
  ]);
  cases("nothing else is", [
    ["the agent page", url("http://localhost:5173/"), r => r === null],
    ["another host", url("https://example.com/bench/minesweeper/"), r => r === null],
    ["a look-alike host", url("http://localhost.example.com/bench/minesweeper/"), r => r === null],
    ["a file", url("file:///C:/game-agent/bench/minesweeper/index.html"), r => r === null],
    ["a user name", url("http://someone@localhost:5173/bench/minesweeper/"), r => r === null],
    ["a longer path", url("http://localhost:5173/benchmark/"), r => r === null],
    ["empty", url(""), r => r === null],
    ["minesweeper.online", url("https://minesweeper.online/bench/x"), r => r === null],
  ]);
}

// ── The questions before a game's first run ───────────────────────────────────
console.log("\nthe questions");
{
  const today = new Date(2026, 8, 24, 12, 0, 0);      // 24 September 2026, on this PC's calendar
  const full = { singlePlayer: true, account: "not-signed-in", rankings: "not-ranked", termsCheckedOn: "2026-09-20", terms: " site rules " };
  check("localDate is YYYY-MM-DD on this PC's calendar", sp.localDate(today) === "2026-09-24", sp.localDate(today));
  cases("answers are saved only when every question is answered, with a real date that is not in the future", [
    ["all answered", sp.ackProblem(full, today), r => r === null],
    ["dated today", sp.ackProblem({ ...full, termsCheckedOn: "2026-09-24" }, today), r => r === null],
    ["the other answers", sp.ackProblem({ ...full, account: "dedicated-profile", rankings: "terms-allow-bots", terms: "" }, today), r => r === null],
    ["not single-player", sp.ackProblem({ ...full, singlePlayer: false }, today), r => /single-player/.test(r)],
    ["single-player as text", sp.ackProblem({ ...full, singlePlayer: "true" }, today), r => /single-player/.test(r)],
    ["no account answer", sp.ackProblem({ ...full, account: "" }, today), r => /signed in/.test(r)],
    ["an answer the dialog does not offer", sp.ackProblem({ ...full, account: "signed-in" }, today), r => typeof r === "string"],
    ["a name every object has", sp.ackProblem({ ...full, account: "toString" }, today), r => typeof r === "string"],
    ["no rankings answer", sp.ackProblem({ ...full, rankings: undefined }, today), r => /rankings/.test(r)],
    ["no date", sp.ackProblem({ ...full, termsCheckedOn: "" }, today), r => /date/.test(r)],
    ["not a day", sp.ackProblem({ ...full, termsCheckedOn: "2026-02-30" }, today), r => /date/.test(r)],
    ["tomorrow", sp.ackProblem({ ...full, termsCheckedOn: "2026-09-25" }, today), r => /after today/.test(r)],
    ["too early", sp.ackProblem({ ...full, termsCheckedOn: "1999-12-31" }, today), r => /before/.test(r)],
    ["a note too long", sp.ackProblem({ ...full, terms: "x".repeat(sp.ACK_TERMS_MAX + 1) }, today), r => /characters/.test(r)],
    ["nothing at all", sp.ackProblem(null, today), r => typeof r === "string"],
  ]);

  const body = sp.ackBody(full, { gameDesc: " Minesweeper ", url: "https://Example.org/play?x=1" });
  check("what is sent: the answers, the note trimmed, and only the site's host from the URL field",
    show(body) === show({ gameDesc: "Minesweeper", singlePlayer: true, account: "not-signed-in", rankings: "not-ranked",
      termsCheckedOn: "2026-09-20", terms: "site rules", site: "example.org" }), show(body));
  check("no note and no URL are sent as null", sp.ackBody({ ...full, terms: "  " }, { gameDesc: "x", url: "" }).terms === null
    && sp.ackBody(full, { gameDesc: "x", url: "" }).site === null);
  // The game-name box has no limit, and a name the backend refused would make
  // the game impossible to answer for, so impossible to start.
  const longName = sp.ackBody(full, { gameDesc: `${"Mines ".repeat(60)}😀😀`, url: "" }).gameDesc;
  const emojiEnd = sp.ackBody(full, { gameDesc: `${"x".repeat(sp.ACK_NAME_MAX - 1)}😀😀`, url: "" }).gameDesc;
  check("a game name longer than the backend keeps is cut short, by whole characters",
    [...longName].length <= sp.ACK_NAME_MAX && longName.startsWith("Mines Mines") && !/\s$/.test(longName)
      && [...emojiEnd].length === sp.ACK_NAME_MAX && emojiEnd.endsWith("x😀") && !/[\uD800-\uDBFF]$/.test(emojiEnd),
    show({ longName: longName.length, emojiEnd: emojiEnd.slice(-4) }));

  const stored = { ...body, acknowledgedAt: "2026-09-24T10:00:00+02:00" };
  delete stored.gameDesc;
  const read = sp.readAck({ gameKey: "minesweeper", sessions: 3, acknowledgement: stored });
  check("what memory keeps reads back", read?.account === "not-signed-in" && read.termsCheckedOn === "2026-09-20"
    && read.acknowledgedAt === "2026-09-24T10:00:00+02:00" && read.site === "example.org", show(read));
  cases("memory without a usable acknowledgement asks again", [
    ["no entry", sp.readAck({}), r => r === null],
    ["none yet", sp.readAck({ sessions: 5 }), r => r === null],
    ["a failed read", sp.readAck({ ok: false, error: "no reply" }), r => r === null],
    ["not single-player", sp.readAck({ acknowledgement: { ...stored, singlePlayer: false } }), r => r === null],
    ["an unknown answer", sp.readAck({ acknowledgement: { ...stored, rankings: "ranked" } }), r => r === null],
    ["no date", sp.readAck({ acknowledgement: { ...stored, termsCheckedOn: null } }), r => r === null],
  ]);

  // The RUN line and run.json.
  const policy = sp.sitePolicyRecord({ ack: read });
  const label = sp.sitePolicyLabel(policy);
  check("the RUN line names the acknowledgement: when, and each answer",
    label === "acknowledged 2026-09-24: single-player, not signed in, results not posted to public rankings, terms checked 2026-09-20 (example.org)",
    label);
  const bench = sp.sitePolicyRecord({ bench: sp.localBench(sp.LOCAL_MINESWEEPER) });
  check("and a local bench page as one", show(bench) === show({ kind: "local-bench", url: sp.LOCAL_MINESWEEPER })
    && sp.sitePolicyLabel(bench) === `local bench page ${sp.LOCAL_MINESWEEPER}`, show(bench));
  check("a run with neither says so", sp.sitePolicyLabel(null) === "no site acknowledgement");

  // The answers are kept per game name; the terms they vouch for are the site's
  // in the URL field when they were given.
  cases("the site the answers were given for, against the URL field now", [
    ["the same site", sp.ackSiteChange(read, "https://example.org/other"), r => r === null],
    ["a subdomain of it", sp.ackSiteChange(read, "www.example.org"), r => r === null],
    ["another site", sp.ackSiteChange(read, "https://example.com/"), r => r?.checked === "example.org" && r.now === "example.com"],
    ["no URL now", sp.ackSiteChange(read, ""), r => r === null],
    ["no site then", sp.ackSiteChange({ ...read, site: null }, "https://example.com/"), r => r === null],
  ]);
  const changed = sp.ackSiteChangeMessage(sp.ackSiteChange(read, "https://example.com/"), " Some game ");
  check("a change of site is said at ▶ Start: which site was checked, which is played, and what to do",
    changed.startsWith('The answers for "Some game" were given for example.org, and the URL field now points at example.com')
      && /■ Stop/.test(changed) && /name of its own/.test(changed), changed);
  cases("run.json and the RUN line name the site played", [
    ["the same site", sp.sitePolicyRecord({ ack: read, url: "https://example.org/x" }),
      r => r.playedOn === "example.org" && sp.sitePolicyLabel(r).endsWith("terms checked 2026-09-20 (example.org)")],
    ["another site", sp.sitePolicyRecord({ ack: read, url: "https://example.com/" }),
      r => r.playedOn === "example.com" && sp.sitePolicyLabel(r).endsWith("terms checked 2026-09-20 (example.org), now played on example.com")],
    ["no site then", sp.sitePolicyRecord({ ack: { ...read, site: null }, url: "example.com" }),
      r => sp.sitePolicyLabel(r).endsWith("terms checked 2026-09-20, played on example.com")],
    ["no URL now", sp.sitePolicyRecord({ ack: read }), r => r.playedOn === null && sp.sitePolicyLabel(r) === label],
  ]);
  const run = { session: "s", page: ep.readVersion({ commit: "0123456" }), backend: ep.readVersion({ commit: "0123456" }),
    gameDesc: "Minesweeper", gamesRequested: 1, sitePolicy: policy };
  check("the RUN line ends with it", ep.runHeader(run).endsWith(` · ${label}`), ep.runHeader(run));
  check("run.json keeps it", ep.RUN_FIELDS.includes("sitePolicy") && show(ep.runRecord(run).sitePolicy) === show(policy),
    show(ep.runRecord(run).sitePolicy));
}

// ── The backend's side agrees ─────────────────────────────────────────────────
console.log("\nthe backend");
{
  const server = fs.readFileSync(path.join(ROOT, "agent_server.py"), "utf8");
  const number = name => server.match(new RegExp(`^${name}\\s*=\\s*(\\d+)\\s*$`, "m"))?.[1];
  const text = name => server.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"\\s*$`, "m"))?.[1];
  check("the backend caps the note on the terms as the page does", Number(number("ACK_TERMS_MAX")) === sp.ACK_TERMS_MAX,
    `${number("ACK_TERMS_MAX")} vs ${sp.ACK_TERMS_MAX}`);
  check("and takes no date before the page's earliest", text("ACK_EARLIEST") === sp.ACK_EARLIEST, `${text("ACK_EARLIEST")} vs ${sp.ACK_EARLIEST}`);
  check("and keeps game names as long as the page sends them",
    Number(number("ACK_NAME_MAX")) === sp.ACK_NAME_MAX && /^\s+gameDesc: str = Field\(min_length=1, max_length=ACK_NAME_MAX\)/m.test(server),
    `${number("ACK_NAME_MAX")} vs ${sp.ACK_NAME_MAX}`);
  const literal = field => {
    const m = server.match(new RegExp(`^\\s+${field}: Literal\\[([^\\]]*)\\]`, "m"));
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]) : null;
  };
  check("the backend accepts the answers the dialog offers, and no others",
    show(literal("account")) === show(Object.keys(sp.ACK_ACCOUNT)) && show(literal("rankings")) === show(Object.keys(sp.ACK_RANKINGS))
      && /^\s+singlePlayer: Literal\[True\]/m.test(server),
    show({ account: literal("account"), rankings: literal("rankings") }));
  check("the backend has the routes the page uses",
    /@app\.get\("\/screen\/foreground"\)/.test(server) && /@app\.post\("\/memory\/\{game_key\}\/acknowledgement"\)/.test(server));
}

// ── The page uses it ──────────────────────────────────────────────────────────
console.log("\nthe page");
{
  const source = fs.readFileSync(path.join(ROOT, "src", "GameAgent.jsx"), "utf8");
  const code = source.replace(/\r\n/g, "\n");
  const from = (a, b) => {
    const i = code.indexOf(a);
    const j = i < 0 ? -1 : code.indexOf(b, i);
    return i < 0 || j < 0 ? "" : code.slice(i, j);
  };
  const start = from("const startAgent = useCallback(", "// Reset everything");
  const siteAt = start.indexOf("const site = await checkSite(nativeMode);");
  check("▶ Start checks the site before the API key, the Ollama server and the model check, and before the reset",
    siteAt > 0 && siteAt < start.indexOf("const prov = PROVIDERS[providerKey];") && siteAt < start.indexOf("checkModel(")
      && /if \(!site\.ok\) \{\s*addLog\(site\.message, site\.type\);\s*if \(site\.ask\) setAckDialog\(site\.ask\);\s*return;\s*\}/.test(start),
    "expected `const site = await checkSite(nativeMode);` and its refusal early in startAgent");
  check("the run's records carry where it played", /sitePolicy: site\.policy,/.test(from("const runSettings = {", "};")));

  const checkSite = from("const checkSite = useCallback(", "}, [gameDesc, gameUrl, selectedWindowTitle, addLog]);");
  const blockedAt = checkSite.indexOf("blockedSite({ desc: gameDesc, url: gameUrl, windows })");
  const frontAt = checkSite.indexOf('windows.push({ title: front.title, where: "the window in front" })');
  const captureAt = checkSite.indexOf('windows.push({ title: selectedWindowTitle, where: "the window chosen for capture" })');
  check("checkSite reads the window in front through the backend, and checks its title and the capture window's",
    checkSite.includes('await backend("/screen/foreground")') && blockedAt > 0
      && frontAt > 0 && frontAt < blockedAt && captureAt > 0 && captureAt < blockedAt,
    "expected both windows.push(...) lines before blockedSite({ desc: gameDesc, url: gameUrl, windows }) in checkSite");
  const benchAt = checkSite.indexOf("localBench(gameUrl)"), memAt = checkSite.indexOf("loadMemory(gameKey)");
  check("a local bench page is let through before memory is read; any other game needs its acknowledgement",
    benchAt > checkSite.indexOf("if (blocked)") && benchAt < memAt && checkSite.includes("readAck(mem)")
      && checkSite.includes("ask: {"), "order in checkSite");
  check("answers given for another site are warned about, and the run's records name the site played",
    /const change = ackSiteChange\(ack, gameUrl\);\s*if \(change\) addLog\(ackSiteChangeMessage\(change, gameDesc\), "warn"\);/.test(checkSite)
      && checkSite.includes("sitePolicyRecord({ ack, url: gameUrl })"), "the acknowledged path in checkSite changed");
  check("no window is focused or brought forward to read it", !/SetForegroundWindow|\.activate\(|\/capture\/select/.test(checkSite));

  const confirm = from("const confirmAck = useCallback(", "}, [ackDialog, addLog, startAgent]);");
  check("saving the answers checks them first, sends them to the game's memory and starts the run",
    confirm.includes("ackProblem(d.form)") && confirm.includes("backend(`/memory/${encodeURIComponent(d.gameKey)}/acknowledgement`")
      && confirm.includes("startAgent();") && confirm.indexOf("ackProblem(") < confirm.indexOf("backend("),
    "confirmAck not found or changed");

  const watch = from("// ── A blocked site in front during a run", "}, [running, addLog, stopAgent]);");
  check("a run asks which window is in front as it starts and then every second, and stops on a blocked site",
    watch.includes("timer = setTimeout(look, SITE_WATCH_MS);") && watch.includes('backend("/screen/foreground")')
      && watch.includes('blockedSite({ windows: [{ title: front.title, where: "the window in front" }] })')
      && watch.includes("blockedSiteMessage(blocked, { running: true })") && watch.includes("stopAgent();")
      && /\n    look\(\);\n    return \(\) => \{ live = false; clearTimeout\(timer\); \};/.test(watch),
    "the watch effect not found or changed");
  check("SITE_WATCH_MS is about a second (the solver's first clicks come within one or two)",
    sp.SITE_WATCH_MS >= 500 && sp.SITE_WATCH_MS <= 1500, String(sp.SITE_WATCH_MS));
  check("no other page code reads window titles", (code.match(/\/screen\/foreground/g) ?? []).length === 2);

  // 🔍 Test Solver reads a board and names the next move: a board analyser, in
  // minesweeper.online's words.
  const solverTest = from("const testSolver = useCallback(", "}, [gameDesc, gameUrl, useNativeCapture, selectedWindowTitle, addLog]);");
  const refuseAt = solverTest.indexOf('if (blocked) { addLog(blockedSiteMessage(blocked, { refused: "Solver test not run" }), "error"); return; }');
  check("🔍 Test Solver refuses a blocked site before it reads the board",
    solverTest.includes("blockedSite({ desc: gameDesc, url: gameUrl,") && refuseAt > 0
      && refuseAt < solverTest.indexOf("captureFrame(") && refuseAt < solverTest.indexOf(".diagnose("),
    "testSolver not found, or its site check changed");
  check("a game name with no letter or digit (no memory name) is refused before memory is read",
    /if \(!gameKey\) \{\s*return \{ ok: false/.test(checkSite) && checkSite.indexOf("if (!gameKey)") < memAt, "guard not found");
  check("the dialog offers exactly the answers the backend accepts",
    show(Object.keys(sp.ACK_ACCOUNT_CHOICES)) === show(Object.keys(sp.ACK_ACCOUNT))
      && show(Object.keys(sp.ACK_RANKINGS_CHOICES)) === show(Object.keys(sp.ACK_RANKINGS))
      && code.includes("Object.entries(ACK_ACCOUNT_CHOICES).map(") && code.includes("Object.entries(ACK_RANKINGS_CHOICES).map("));
}

// ── The questions render ──────────────────────────────────────────────────────
// check-render.mjs renders the page as it first loads, when no dialog is open.
// This renders it with the questions open and half answered, so a fault in the
// dialog (it is built only once ▶ Start asks) fails here, not on the test PC.
console.log("\nthe questions, rendered");
{
  const { build } = await import("esbuild");
  const requireFromRoot = createRequire(path.join(ROOT, "package.json"));
  const entry = path.join(ROOT, "src", "GameAgent.jsx");
  const CLOSED = "const [ackDialog, setAckDialog] = useState(null);";
  const answers = { singlePlayer: true, account: "dedicated-profile", rankings: "", termsCheckedOn: "2026-09-20", terms: "https://example.org/terms" };
  const open = {
    gameKey: "some-web-game", gameDesc: "Some web game", url: "https://example.org/play",
    form: answers, error: sp.ackProblem(answers), saving: false,
  };
  const bundlePath = path.join(os.tmpdir(), `game-agent-ack-${process.pid}-${randomUUID()}.mjs`);
  try {
    const source = fs.readFileSync(entry, "utf8");
    check("the dialog starts closed", source.includes(CLOSED), `expected "${CLOSED}" in GameAgent.jsx`);
    await build({
      entryPoints: [entry], bundle: true, platform: "node", format: "esm", jsx: "automatic",
      outfile: bundlePath, logLevel: "silent",
      plugins: [{
        name: "open-the-questions",
        setup(b) {
          // React from the repo's node_modules, outside the bundle (see check-render.mjs).
          b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, a => ({ path: pathToFileURL(requireFromRoot.resolve(a.path)).href, external: true }));
          b.onLoad({ filter: /GameAgent\.jsx$/ }, () => ({
            contents: source.replace(CLOSED, `const [ackDialog, setAckDialog] = useState(${JSON.stringify(open)});`),
            loader: "jsx", resolveDir: path.dirname(entry),
          }));
        },
      }],
    });
    const { renderToString } = requireFromRoot("react-dom/server");
    const { createElement } = requireFromRoot("react");
    const mod = await import(pathToFileURL(bundlePath).href);
    const html = renderToString(createElement(mod.default))
      .replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const missing = [
      'Before the first run of "Some web game"', "Single-player.", sp.LOCAL_MINESWEEPER, "Save and start", "Cancel",
      ...Object.values(sp.ACK_ACCOUNT_CHOICES), ...Object.values(sp.ACK_RANKINGS_CHOICES), open.error,
    ].filter(text => !html.includes(text));
    check("the questions render: single-player, the account, rankings, the date, and what is still missing",
      !missing.length && typeof open.error === "string" && /type="date"[^>]*value="2026-09-20"/.test(html),
      `missing: ${missing.join(" | ")}`);
  } catch (e) {
    check("the questions render", false, e?.errors?.length ? e.errors.map(x => x.text).join("; ") : (e?.stack ?? String(e)));
  } finally {
    fs.rmSync(bundlePath, { force: true });
  }
}

// ── The docs ──────────────────────────────────────────────────────────────────
console.log("\nthe docs");
{
  const setup = fs.readFileSync(path.join(ROOT, "SETUP.md"), "utf8");
  const claude = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
  check("SETUP.md states the policy, cites minesweeper.online's rules and points Minesweeper at the local page",
    /### Which games the agent may play/.test(setup) && setup.includes("https://minesweeper.online/help/website-rules")
      && setup.includes(sp.LOCAL_MINESWEEPER) && /never signed in/i.test(setup) && /multiplayer/i.test(setup));
  check("CLAUDE.md holds the same rule for later changes",
    /minesweeper\.online/.test(claude) && /bench\//.test(claude) && /src\/agent\/sitePolicy\.js/.test(claude));
}

console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
