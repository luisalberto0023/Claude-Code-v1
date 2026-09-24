// Which commit this checkout is at, for the page's record of the code it runs.
//
// The page gets it as __AGENT_VERSION__ (src/agent/episodes.js reads it). The
// backend reads its own commit the same way when it starts (read_version in
// agent_server.py), and at ▶ Start the page says loudly when the two differ: the
// test PC gets code only through git pull, and a backend started before a pull
// keeps running the old code.
//
// When it is read matters. `npm run dev` serves the files as they are on disk
// now, so after a pull a reloaded page runs the new code even though Vite was
// started before the pull. A commit read once when Vite started would still
// name the old one, match a backend that is just as old, and hide exactly the
// mix-up this is for. So the dev server reads it again for every page load
// (agentVersion, below, as the token plugin does for the token), and only
// `npm run build`, whose output does not change after it is built, fixes it
// into the page with a Vite define (vite.config.js). The other half is that a
// tab's code changes only when it loads: vite.config.js turns hot updates off,
// which would otherwise swap pulled code into an open tab that still names the
// commit it was loaded with.
//
// One git command gives the commit, the branch and whether tracked files were
// changed since (dirty); untracked files are not counted. Where git cannot run,
// the commit is read from .git's own files and dirty is unknown (null). Neither
// working is not an error: the page still starts, and says why it cannot tell.
// Keep this in step with read_version in agent_server.py; tools/check-episodes.mjs
// checks this file.

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

export const GIT_STATUS_ARGS = ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=no"];
export const GIT_TIMEOUT_MS = 5000;
export const SHORT_COMMIT = 7; // fixed, so the same commit reads the same on every machine
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The commit, branch and dirty flag in `git status --porcelain=v2 --branch` output. */
export function parseGitStatus(text) {
  let full = null, branch = null, dirty = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.startsWith("# branch.oid ")) {
      const value = line.slice("# branch.oid ".length).trim();
      full = COMMIT.test(value) ? value : null;
    } else if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      branch = value === "(detached)" ? null : value;
    } else if (line.trim() && !line.startsWith("#")) {
      dirty = true;
    }
  }
  return { full, branch, dirty };
}

/** The commit from .git's own files, for when git cannot run. Throws when they name none. */
export function versionFromFiles(root) {
  const gitDir = path.join(root, ".git");
  const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  let branch = null, full = head;
  if (head.startsWith("ref: ")) {
    const ref = head.slice("ref: ".length).trim();
    branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    const loose = path.join(gitDir, ...ref.split("/"));
    full = fs.existsSync(loose) && fs.statSync(loose).isFile() ? fs.readFileSync(loose, "utf8").trim() : null;
    const packed = path.join(gitDir, "packed-refs");
    if (full == null && fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, "utf8").split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length === 2 && parts[1] === ref) full = parts[0];
      }
    }
  }
  if (!full || !COMMIT.test(full)) throw new Error(`${gitDir} names no commit`);
  return { full, branch, dirty: null };
}

const firstLine = text => String(text ?? "").split(/\r?\n/).map(l => l.trim()).find(Boolean)?.slice(0, 200) ?? "";

function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Which commit `root` is checked out at: {commit, commitFull, dirty, branch,
 * source, error}. Never throws: commit is null and error says why when neither
 * git nor .git's files could tell. `run(args, cwd)` returns git's output or
 * throws as execFileSync does; the checks pass a stand-in.
 */
export function gitVersion(root, { run = runGit } = {}) {
  let found, source;
  try {
    found = parseGitStatus(run(GIT_STATUS_ARGS, root));
    if (!found.full) throw new Error("the checkout has no commit yet");
    source = "git";
  } catch (e) {
    const gitError = e?.code === "ENOENT" ? "git is not on PATH"
      : `git: ${firstLine(e?.stderr?.toString?.()) || e?.message || String(e)}`;
    try {
      found = versionFromFiles(root);
      source = `.git files (${gitError})`;
    } catch (e2) {
      return { commit: null, commitFull: null, dirty: null, branch: null, source: null, error: `${gitError}; ${e2.message}` };
    }
  }
  return {
    commit: found.full.slice(0, SHORT_COMMIT), commitFull: found.full, dirty: found.dirty,
    branch: found.branch, source, error: null,
  };
}

/**
 * The script that tells the page which commit it is. `<` is written as <,
 * so no branch name (git allows `<` and `/` in one) can end the script early.
 */
export function versionScript(version) {
  return `window.__AGENT_VERSION__ = ${JSON.stringify(version ?? null).replace(/</g, "\\u003c")};`;
}

/**
 * The dev-server plugin that puts this checkout's commit in the page on every
 * page load (see the top of this file for why not once). `read` is gitVersion,
 * or a stand-in in the checks.
 */
export function agentVersion({ root, read = gitVersion } = {}) {
  let folder = root ?? process.cwd();
  return {
    name: "agent-version",
    apply: "serve",
    configResolved(config) {
      if (!root) folder = config.root;
    },
    transformIndexHtml() {
      return [{ tag: "script", children: versionScript(read(folder)), injectTo: "head-prepend" }];
    },
  };
}
