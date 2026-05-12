#!/usr/bin/env python3
"""
Autonomous Mobile Game Bot – CLI entry point.

Usage:
    # Basic run (game package auto-detected or set via env)
    python run_bot.py

    # Target a specific app
    python run_bot.py --package com.supercell.clashofclans

    # Use a specific ADB device (useful with multiple phones connected)
    python run_bot.py --device emulator-5554

    # Dump memory contents (useful for debugging what the bot has learned)
    python run_bot.py --inspect

    # Reset all memory for a fresh start
    python run_bot.py --reset-memory

Environment variables (alternative to CLI flags):
    ANTHROPIC_API_KEY   Required. Your Anthropic API key.
    GAME_PACKAGE        Android package name of the target game.
    ADB_DEVICE          Serial of the ADB device to use.
"""

import argparse
import logging
import os
import sys


def setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    fmt = "%(asctime)s  %(levelname)-8s  %(name)-25s  %(message)s"
    logging.basicConfig(level=level, format=fmt)
    # Silence noisy third-party loggers
    for noisy in ("urllib3", "httpx", "httpcore", "anthropic"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Autonomous Mobile Game Bot",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--package", "-p", default="",
                   help="Android package name of the game (overrides GAME_PACKAGE env var)")
    p.add_argument("--device", "-d", default="",
                   help="ADB device serial (overrides ADB_DEVICE env var)")
    p.add_argument("--api-key", default="",
                   help="Anthropic API key (overrides ANTHROPIC_API_KEY env var)")
    p.add_argument("--db", default="",
                   help="Path to the SQLite memory database (default: game_bot.db)")
    p.add_argument("--screenshots-dir", default="",
                   help="Directory to store screenshots (default: screenshots/)")
    p.add_argument("--max-actions", type=int, default=0,
                   help="Stop after this many actions (0 = unlimited)")
    p.add_argument("--reflect-every", type=int, default=0,
                   help="Run reflection every N actions (0 = use default)")
    p.add_argument("--inspect", action="store_true",
                   help="Print current memory contents and exit")
    p.add_argument("--reset-memory", action="store_true",
                   help="Delete the memory database and exit")
    p.add_argument("-v", "--verbose", action="store_true",
                   help="Enable debug logging")
    return p.parse_args()


def apply_cli_overrides(args: argparse.Namespace) -> None:
    """Push CLI args into the config singleton before any module uses it."""
    from game_bot.config import config

    if args.api_key:
        config.anthropic_api_key = args.api_key
        os.environ["ANTHROPIC_API_KEY"] = args.api_key  # SDK reads from env

    if args.package:
        config.game_package = args.package

    if args.device:
        config.adb_device = args.device

    if args.db:
        config.db_path = args.db

    if args.screenshots_dir:
        config.screenshots_dir = args.screenshots_dir

    if args.max_actions:
        config.max_session_actions = args.max_actions

    if args.reflect_every:
        config.reflect_every_n_actions = args.reflect_every


def cmd_inspect() -> None:
    from game_bot.memory_system import MemorySystem
    mem = MemorySystem()

    print("\n=== GAME KNOWLEDGE ===")
    print(mem.knowledge_summary())

    print("\n=== STRATEGIES ===")
    print(mem.strategies_summary())

    print("\n=== ACHIEVEMENTS ===")
    print(mem.achievements_summary())

    print(f"\n=== STATS ===")
    print(f"Total actions logged: {mem.action_count()}")
    print(f"Recent actions (last 10):\n{mem.recent_actions_summary(10)}")


def cmd_reset_memory(db_path: str) -> None:
    import pathlib
    path = pathlib.Path(db_path)
    if path.exists():
        answer = input(f"Delete {path}? This cannot be undone. [y/N] ")
        if answer.lower() == "y":
            path.unlink()
            print(f"Deleted {path}")
        else:
            print("Aborted.")
    else:
        print(f"No database found at {path}")


def main() -> int:
    args = parse_args()
    setup_logging(args.verbose)

    # Apply CLI overrides before importing any bot module
    apply_cli_overrides(args)

    from game_bot.config import config

    # Guard: API key must be present for anything that contacts Claude
    if not args.inspect and not args.reset_memory:
        if not config.anthropic_api_key:
            print(
                "ERROR: ANTHROPIC_API_KEY is not set.\n"
                "Export it with:  export ANTHROPIC_API_KEY=sk-ant-...\n"
                "Or pass it with: --api-key sk-ant-...",
                file=sys.stderr,
            )
            return 1

    if args.inspect:
        cmd_inspect()
        return 0

    if args.reset_memory:
        cmd_reset_memory(config.db_path)
        return 0

    # Normal run
    print(
        f"\n{'='*60}\n"
        f"  Autonomous Mobile Game Bot\n"
        f"  Game package : {config.game_package or '(auto-detect)'}\n"
        f"  ADB device   : {config.adb_device or '(auto-detect)'}\n"
        f"  Max actions  : {config.max_session_actions}\n"
        f"  DB path      : {config.db_path}\n"
        f"{'='*60}\n"
    )

    from game_bot.game_agent import GameAgent
    agent = GameAgent()
    agent.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
