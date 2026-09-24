// ── Getting log lines and run records to disk ─────────────────────────────────
//
// The page queues every log line, and the run, game and turn records
// (episodes.js, turnClock.js), and a timer sends them to the backend every 2 s,
// in batches it accepts. A batch that did not get through used to be lost:
// backend() reports a failure rather than throwing it, the flush never looked
// at the reply, and a backend restart left a hole in the log file that nothing
// mentioned. Now:
//   - a batch that may get through later (no answer, the backend could not
//     write, the page refused until it is reloaded) goes back in front of the
//     queue, with everything after it, for the next flush;
//   - a batch the backend will never accept (a body it refuses, 413 over its
//     caps, a route an older backend does not have) is dropped, and the page
//     says so once;
//   - the queue is bounded, so a backend gone for good does not grow the page's
//     memory without end. What is dropped for room is the oldest, turn records
//     before a run's or a game's, and it is counted and said once lines get
//     through again;
//   - a batch the backend crashes on (a server error with no JSON: its route
//     failed on this request) is retried, but dropped and said after
//     CRASH_RETRIES crashes in a row: the same request fails the same way, and
//     retried for as long as the page is open it held back everything queued
//     after it. A backend that is down never counts as a crash.
// The log file also gets each line whole: only the on-screen log cuts a long
// one short (onScreen), so a model's full reply is always on disk.
//
// tools/check-episodes.mjs checks this module.

import { logBatches, backendFailure } from "./backend.js";

// How much waits for a backend that is not taking writes. A log line is a few
// hundred bytes, a turn record about 400: a few megabytes at most.
export const LOG_QUEUE_MAX = 5000;
export const RECORD_QUEUE_MAX = 2000;
// What one request may write: EPISODE_RECORD_MAX_BYTES, TURN_RECORDS_MAX and
// TURN_RECORDS_MAX_BYTES in agent_server.py, the same numbers
// (tools/check-episodes.mjs fails if they differ).
export const EPISODE_RECORD_MAX_BYTES = 64 * 1024;
export const TURN_RECORDS_MAX = 1000;
export const TURN_RECORDS_MAX_BYTES = 1024 * 1024;
// The backend counts a turn record's bytes as it writes the line, after adding
// {"format":1,...} to it (11 bytes), so a batch is packed with room for that:
// one that fits by the page's count alone could still be refused as too large.
export const TURN_RECORD_STAMP_BYTES = 16;
// Crashes in a row (a flush every 2 s: ten seconds) before the batch at the
// front of the queue is dropped.
export const CRASH_RETRIES = 5;

const RECORD_ROUTES = { run: "/episode/run", game: "/episode/game", turn: "/episode/turns" };

/**
 * An empty queue: the items waiting, how many were dropped for room since last
 * said, and the item at the front of the batch the backend last crashed on,
 * with how many times in a row it has.
 */
export function newQueue() {
  return { items: [], dropped: 0, crashes: null };
}

/** Text as the on-screen log shows it: at most `max` characters, and … when cut. */
export function onScreen(text, max) {
  const s = String(text ?? "");
  return Number.isFinite(max) && max > 0 && s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * What to do with a batch after the backend's reply: "sent"; "retry" at the
 * next flush; or "drop", for a request the backend will never accept.
 */
export function sendVerdict(reply) {
  if (reply?.ok === true) return "sent";
  // Refused for the page's token or origin: the page has to be reloaded, and
  // until then the queue keeps what it can.
  if (reply?.refused) return "retry";
  // 413 over a cap, or a body FastAPI refused (its 422, and its 404 for a
  // route an older backend does not have, both carry detail).
  if (reply?.tooLarge === true || reply?.detail != null) return "drop";
  return "retry";
}

/**
 * Put `unsent` back in front of the queue, before anything queued since, and
 * keep the queue at `max` items at most: the oldest go first, except those
 * `keep(item)` protects, which go only when nothing else is left to drop.
 * Returns how many were dropped (also added to queue.dropped).
 */
export function putBack(queue, unsent, { max = Infinity, keep = () => false } = {}) {
  const all = [...unsent, ...queue.items];
  const over = all.length - max;
  const drop = new Set();
  for (let i = 0; i < all.length && drop.size < over; i++) if (!keep(all[i])) drop.add(i);
  for (let i = 0; i < all.length && drop.size < over; i++) drop.add(i);
  queue.items = drop.size ? all.filter((_, i) => !drop.has(i)) : all;
  queue.dropped += drop.size;
  return drop.size;
}

/**
 * Queued log lines, {session, line}, as /log/append batches: one session per
 * batch, each within the backend's caps (logBatches, which cuts a line too long
 * to send at all). Each batch keeps the items it came from, to go back in the
 * queue if it does not get through.
 */
export function logLineBatches(items) {
  const batches = [];
  for (let i = 0; i < items.length;) {
    let j = i;
    while (j < items.length && items[j].session === items[i].session) j++;
    const group = items.slice(i, j);
    let at = 0;
    for (const lines of logBatches(group.map(it => it.line))) {
      batches.push({ items: group.slice(at, at + lines.length), path: "/log/append", body: { session: items[i].session, lines } });
      at += lines.length;
    }
    i = j;
  }
  return batches;
}

const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Queued records, {session, kind: run|game|turn, record}, as backend requests,
 * in order: one per run or game record, and turn records of one session
 * together, within TURN_RECORDS_MAX and TURN_RECORDS_MAX_BYTES.
 */
export function recordBatches(items) {
  const batches = [];
  let turns = null;
  for (const it of items) {
    const path = RECORD_ROUTES[it.kind];
    if (!path) continue;
    if (it.kind !== "turn") {
      turns = null;
      batches.push({ items: [it], path, body: { session: it.session, [it.kind]: it.record } });
      continue;
    }
    const bytes = jsonBytes(it.record) + 1 + TURN_RECORD_STAMP_BYTES;
    if (!turns || turns.body.session !== it.session || turns.items.length >= TURN_RECORDS_MAX
        || turns.bytes + bytes > TURN_RECORDS_MAX_BYTES) {
      turns = { items: [], path, body: { session: it.session, records: [] }, bytes: 0 };
      batches.push(turns);
    }
    turns.items.push(it);
    turns.body.records.push(it.record);
    turns.bytes += bytes;
  }
  return batches.map(({ bytes: _bytes, ...batch }) => batch);
}

/**
 * Send everything queued, in order, as `plan(items)` batches it, through
 * `send(batch)` (which returns the backend's reply). Stops at the first batch
 * worth retrying and puts it back with everything after it (putBack, with `max`
 * and `keep`); drops a batch the backend will never accept, or has crashed on
 * CRASH_RETRIES flushes in a row. Returns {sent, refused: [{batch, reason}],
 * waiting: reason or null}.
 */
export async function drainQueue(queue, { plan, send, max = Infinity, keep } = {}) {
  const out = { sent: 0, refused: [], waiting: null };
  const taken = queue.items;
  queue.items = [];
  if (!taken.length) return out;
  const batches = plan(taken);
  for (let i = 0; i < batches.length; i++) {
    let reply;
    try {
      reply = await send(batches[i]);
    } catch (e) {
      reply = { ok: false, error: e?.message ?? String(e) };
    }
    const verdict = sendVerdict(reply);
    if (verdict === "sent") {
      out.sent += batches[i].items.length;
    } else if (verdict === "drop") {
      out.refused.push({ batch: batches[i], reason: backendFailure(reply) });
    } else {
      // The same batch starts with the same item at every flush: putBack keeps
      // it in front.
      const head = batches[i].items[0];
      const crashes = reply?.crashed === true ? (queue.crashes?.head === head ? queue.crashes.count : 0) + 1 : 0;
      queue.crashes = crashes ? { head, count: crashes } : null;
      if (crashes >= CRASH_RETRIES) {
        queue.crashes = null;
        out.refused.push({ batch: batches[i], reason: `${backendFailure(reply)}, ${crashes} times in a row` });
        continue;
      }
      putBack(queue, batches.slice(i).flatMap(b => b.items), { max, keep });
      out.waiting = backendFailure(reply);
      break;
    }
  }
  return out;
}

/** A run's and a game's records outweigh any number of turns when the queue is full. */
export const keepRecord = item => item?.kind !== "turn";

/**
 * What a flush should say in the log, as [{key, type, text}]: `key` names the
 * note, so the page says each one once. `lines` and `records` are drainQueue's
 * results; the queues are read for what was dropped for room, and reset.
 */
export function flushNotes({ lines, records, logQueue, recordQueue }) {
  const notes = [];
  if (lines?.sent && logQueue?.dropped) {
    notes.push({
      key: null, type: "warn",
      text: `⚠ ${logQueue.dropped} log lines were dropped from the log file while the backend was not taking them ` +
        `(the page keeps at most ${LOG_QUEUE_MAX} waiting). 💾 Save log still has every line.`,
    });
    logQueue.dropped = 0;
  }
  for (const { batch, reason } of lines?.refused ?? []) {
    notes.push({
      key: `lines:${reason}`, type: "warn",
      text: `⚠ The backend refused ${batch.items.length} log lines (${reason}); they are only in 💾 Save log.`,
    });
  }
  if (records?.sent && recordQueue?.dropped) {
    notes.push({
      key: null, type: "warn",
      text: `📒 ${recordQueue.dropped} run records (turns first) were dropped while the backend was not taking them ` +
        `(the page keeps at most ${RECORD_QUEUE_MAX} waiting).`,
    });
    recordQueue.dropped = 0;
  }
  for (const { batch, reason } of records?.refused ?? []) {
    const old = /not found/i.test(reason) ? " The backend is older than this page: restart start.bat." : "";
    notes.push({
      key: `records:${batch.path}:${reason}`, type: "warn",
      text: `📒 Run records not written (${batch.path}): ${reason}.${old}`,
    });
  }
  return notes;
}
