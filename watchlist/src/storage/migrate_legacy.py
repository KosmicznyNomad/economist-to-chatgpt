from __future__ import annotations

import argparse

from .positions_store import load_positions


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate legacy positions.json to psm_v4 schema.")
    parser.add_argument(
        "--path",
        default="data/positions.json",
        help="Path to positions file (default: data/positions.json).",
    )
    args = parser.parse_args()
    load_positions(args.path)
    print(f"Migrated and validated: {args.path}")


if __name__ == "__main__":
    main()
