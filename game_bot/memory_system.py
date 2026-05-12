"""
Persistent memory for the game bot – powered by SQLite.

The bot has four kinds of memory, mirroring how humans learn games:

1. Game Knowledge  – facts about this game (mechanics, controls, rules)
2. Strategies      – what to do in each situation, scored by success rate
3. Action History  – full log of every action taken and its outcome
4. Achievements    – milestones reached (tutorials done, levels beaten, …)

All writes are atomic. Reads expose clean Python dataclasses.
"""

import json
import logging
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Generator, Optional

from .config import config

log = logging.getLogger(__name__)


# ── Data models ───────────────────────────────────────────────────────────────

@dataclass
class ActionRecord:
    screen_type: str
    action_type: str
    nx: float
    ny: float
    params: dict[str, Any]
    reasoning: str
    outcome: str          # "success" | "failure" | "no_change" | "progress"
    screenshot_path: str
    timestamp: float = field(default_factory=time.time)
    id: Optional[int] = None


@dataclass
class Strategy:
    situation: str        # e.g. "tutorial_arrow_pointing_right"
    action_type: str
    nx: float
    ny: float
    params: dict[str, Any]
    description: str
    success_count: int = 0
    failure_count: int = 0
    id: Optional[int] = None

    @property
    def success_rate(self) -> float:
        total = self.success_count + self.failure_count
        return self.success_count / total if total else 0.0


@dataclass
class Achievement:
    title: str
    description: str
    screen_type: str
    action_count_at_time: int
    timestamp: float = field(default_factory=time.time)
    id: Optional[int] = None


# ── MemorySystem ──────────────────────────────────────────────────────────────

class MemorySystem:
    """
    Thread-safe SQLite-backed memory for the autonomous game agent.
    """

    def __init__(self, db_path: Optional[str] = None):
        self._db_path = db_path or config.db_path
        self._init_db()
        log.info("MemorySystem initialised at %s", self._db_path)

    # ── Context manager for connections ──────────────────────────────────────

    @contextmanager
    def _conn(self) -> Generator[sqlite3.Connection, None, None]:
        conn = sqlite3.connect(self._db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ── Schema ────────────────────────────────────────────────────────────────

    def _init_db(self) -> None:
        with self._conn() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS game_knowledge (
                    id        INTEGER PRIMARY KEY AUTOINCREMENT,
                    category  TEXT NOT NULL,
                    fact      TEXT NOT NULL UNIQUE,
                    details   TEXT DEFAULT '',
                    confidence REAL DEFAULT 1.0,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS strategies (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    situation     TEXT NOT NULL,
                    action_type   TEXT NOT NULL,
                    nx            REAL NOT NULL,
                    ny            REAL NOT NULL,
                    params        TEXT DEFAULT '{}',
                    description   TEXT NOT NULL,
                    success_count INTEGER DEFAULT 0,
                    failure_count INTEGER DEFAULT 0,
                    created_at    REAL NOT NULL,
                    updated_at    REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_strategies_situation
                    ON strategies(situation);

                CREATE TABLE IF NOT EXISTS action_history (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    screen_type     TEXT NOT NULL,
                    action_type     TEXT NOT NULL,
                    nx              REAL NOT NULL,
                    ny              REAL NOT NULL,
                    params          TEXT DEFAULT '{}',
                    reasoning       TEXT DEFAULT '',
                    outcome         TEXT NOT NULL,
                    screenshot_path TEXT DEFAULT '',
                    timestamp       REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS achievements (
                    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                    title                TEXT NOT NULL UNIQUE,
                    description          TEXT NOT NULL,
                    screen_type          TEXT NOT NULL,
                    action_count_at_time INTEGER NOT NULL,
                    timestamp            REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    started_at  REAL NOT NULL,
                    ended_at    REAL,
                    total_actions INTEGER DEFAULT 0,
                    notes       TEXT DEFAULT ''
                );
            """)

    # ── Game Knowledge ────────────────────────────────────────────────────────

    def add_knowledge(
        self, category: str, fact: str, details: str = "", confidence: float = 1.0
    ) -> None:
        now = time.time()
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO game_knowledge (category, fact, details, confidence,
                                            created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(fact) DO UPDATE SET
                    details    = excluded.details,
                    confidence = excluded.confidence,
                    updated_at = excluded.updated_at
                """,
                (category, fact, details, confidence, now, now),
            )

    def get_knowledge(self, category: Optional[str] = None) -> list[dict]:
        with self._conn() as conn:
            if category:
                rows = conn.execute(
                    "SELECT * FROM game_knowledge WHERE category=? ORDER BY confidence DESC",
                    (category,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM game_knowledge ORDER BY confidence DESC"
                ).fetchall()
            return [dict(r) for r in rows]

    def knowledge_summary(self, max_facts: int = 40) -> str:
        """Return a compact text summary of what the bot knows about the game."""
        rows = self.get_knowledge()[:max_facts]
        if not rows:
            return "No game knowledge yet."
        lines = []
        for r in rows:
            lines.append(f"[{r['category']}] {r['fact']}: {r['details']}")
        return "\n".join(lines)

    # ── Strategies ────────────────────────────────────────────────────────────

    def upsert_strategy(self, strategy: Strategy) -> int:
        now = time.time()
        with self._conn() as conn:
            existing = conn.execute(
                "SELECT id FROM strategies WHERE situation=? AND action_type=?",
                (strategy.situation, strategy.action_type),
            ).fetchone()
            if existing:
                conn.execute(
                    """
                    UPDATE strategies SET nx=?, ny=?, params=?, description=?,
                        success_count=?, failure_count=?, updated_at=?
                    WHERE id=?
                    """,
                    (
                        strategy.nx, strategy.ny,
                        json.dumps(strategy.params), strategy.description,
                        strategy.success_count, strategy.failure_count,
                        now, existing["id"],
                    ),
                )
                return existing["id"]
            else:
                cur = conn.execute(
                    """
                    INSERT INTO strategies
                        (situation, action_type, nx, ny, params, description,
                         success_count, failure_count, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        strategy.situation, strategy.action_type,
                        strategy.nx, strategy.ny, json.dumps(strategy.params),
                        strategy.description,
                        strategy.success_count, strategy.failure_count,
                        now, now,
                    ),
                )
                return cur.lastrowid

    def get_strategies(self, situation: Optional[str] = None) -> list[Strategy]:
        with self._conn() as conn:
            if situation:
                rows = conn.execute(
                    "SELECT * FROM strategies WHERE situation=? ORDER BY success_count DESC",
                    (situation,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM strategies ORDER BY success_count DESC"
                ).fetchall()
            return [self._row_to_strategy(r) for r in rows]

    def record_strategy_outcome(
        self, strategy_id: int, success: bool
    ) -> None:
        col = "success_count" if success else "failure_count"
        with self._conn() as conn:
            conn.execute(
                f"UPDATE strategies SET {col}={col}+1, updated_at=? WHERE id=?",
                (time.time(), strategy_id),
            )

    def strategies_summary(self, situation: Optional[str] = None) -> str:
        strats = self.get_strategies(situation)[:20]
        if not strats:
            return "No strategies learned yet."
        lines = []
        for s in strats:
            rate = f"{s.success_rate:.0%}"
            lines.append(
                f"[{s.situation}] {s.action_type} @ ({s.nx:.2f},{s.ny:.2f}) "
                f"– {s.description} (success {rate}, "
                f"n={s.success_count+s.failure_count})"
            )
        return "\n".join(lines)

    # ── Action History ────────────────────────────────────────────────────────

    def log_action(self, record: ActionRecord) -> int:
        with self._conn() as conn:
            cur = conn.execute(
                """
                INSERT INTO action_history
                    (screen_type, action_type, nx, ny, params, reasoning,
                     outcome, screenshot_path, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.screen_type, record.action_type,
                    record.nx, record.ny, json.dumps(record.params),
                    record.reasoning, record.outcome,
                    record.screenshot_path, record.timestamp,
                ),
            )
            return cur.lastrowid

    def recent_actions(self, n: int = 20) -> list[ActionRecord]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM action_history ORDER BY id DESC LIMIT ?", (n,)
            ).fetchall()
            return [self._row_to_action(r) for r in reversed(rows)]

    def action_count(self) -> int:
        with self._conn() as conn:
            return conn.execute(
                "SELECT COUNT(*) FROM action_history"
            ).fetchone()[0]

    def recent_actions_summary(self, n: int = 15) -> str:
        actions = self.recent_actions(n)
        if not actions:
            return "No actions recorded yet."
        lines = []
        for a in actions:
            lines.append(
                f"{a.action_type} @ ({a.nx:.2f},{a.ny:.2f}) on {a.screen_type} "
                f"→ {a.outcome}"
            )
        return "\n".join(lines)

    # ── Achievements ──────────────────────────────────────────────────────────

    def record_achievement(self, achievement: Achievement) -> bool:
        """Returns True if this is a new achievement (not a duplicate)."""
        try:
            with self._conn() as conn:
                conn.execute(
                    """
                    INSERT INTO achievements
                        (title, description, screen_type, action_count_at_time, timestamp)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        achievement.title, achievement.description,
                        achievement.screen_type,
                        achievement.action_count_at_time,
                        achievement.timestamp,
                    ),
                )
            log.info("ACHIEVEMENT: %s", achievement.title)
            return True
        except sqlite3.IntegrityError:
            return False  # already recorded

    def get_achievements(self) -> list[Achievement]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM achievements ORDER BY timestamp"
            ).fetchall()
            return [self._row_to_achievement(r) for r in rows]

    def achievements_summary(self) -> str:
        ach = self.get_achievements()
        if not ach:
            return "No achievements yet."
        return "\n".join(f"✓ {a.title}: {a.description}" for a in ach)

    # ── Session management ────────────────────────────────────────────────────

    def start_session(self) -> int:
        with self._conn() as conn:
            cur = conn.execute(
                "INSERT INTO sessions (started_at) VALUES (?)", (time.time(),)
            )
            return cur.lastrowid

    def end_session(self, session_id: int, notes: str = "") -> None:
        with self._conn() as conn:
            conn.execute(
                """
                UPDATE sessions SET ended_at=?, total_actions=?, notes=?
                WHERE id=?
                """,
                (time.time(), self.action_count(), notes, session_id),
            )

    # ── Stuck detection ───────────────────────────────────────────────────────

    def is_stuck(self, threshold: Optional[int] = None) -> bool:
        """True if the last `threshold` actions all resulted in no_change."""
        n = threshold or config.stuck_threshold
        recent = self.recent_actions(n)
        if len(recent) < n:
            return False
        return all(a.outcome in ("no_change", "failure") for a in recent)

    # ── Row converters ────────────────────────────────────────────────────────

    @staticmethod
    def _row_to_action(row: sqlite3.Row) -> ActionRecord:
        return ActionRecord(
            id=row["id"],
            screen_type=row["screen_type"],
            action_type=row["action_type"],
            nx=row["nx"],
            ny=row["ny"],
            params=json.loads(row["params"] or "{}"),
            reasoning=row["reasoning"],
            outcome=row["outcome"],
            screenshot_path=row["screenshot_path"],
            timestamp=row["timestamp"],
        )

    @staticmethod
    def _row_to_strategy(row: sqlite3.Row) -> Strategy:
        return Strategy(
            id=row["id"],
            situation=row["situation"],
            action_type=row["action_type"],
            nx=row["nx"],
            ny=row["ny"],
            params=json.loads(row["params"] or "{}"),
            description=row["description"],
            success_count=row["success_count"],
            failure_count=row["failure_count"],
        )

    @staticmethod
    def _row_to_achievement(row: sqlite3.Row) -> Achievement:
        return Achievement(
            id=row["id"],
            title=row["title"],
            description=row["description"],
            screen_type=row["screen_type"],
            action_count_at_time=row["action_count_at_time"],
            timestamp=row["timestamp"],
        )
