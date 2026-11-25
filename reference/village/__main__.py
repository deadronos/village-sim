"""CLI: run a simulated village day against a local System One server."""

from __future__ import annotations

import argparse
from pathlib import Path

from . import config
from .sim import run, summarize


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="village", description="Autonomous village life sim")
    ap.add_argument("--seed", type=int, default=7, help="world seed (weather + sampling)")
    ap.add_argument("--days", type=int, default=1)
    ap.add_argument("--url", default=config.KEV_URL, help="System One endpoint")
    ap.add_argument("--no-llm", action="store_true", help="use scripted rules only")
    ap.add_argument("--quiet", action="store_true", help="summary only")
    ap.add_argument("--log", default=None, help="JSONL decision log path")
    args = ap.parse_args(argv)

    log_path = args.log
    if log_path is None:
        out = Path("runs") / f"seed-{args.seed}.jsonl"
        out.parent.mkdir(parents=True, exist_ok=True)
        log_path = out

    stats = run(seed=args.seed, days=args.days, use_llm=not args.no_llm,
                verbose=not args.quiet, log_path=log_path)
    summarize(stats)
    print(f"decision log: {log_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
