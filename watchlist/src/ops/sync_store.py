from __future__ import annotations

import argparse

from src.storage.positions_store import iter_positions, load_positions, save_positions


def main() -> None:
    parser = argparse.ArgumentParser(description="Synchronize state store between JSON and PostgreSQL backends.")
    parser.add_argument("--from-path", required=True, help="Source backend path (file path or PostgreSQL DSN).")
    parser.add_argument("--to-path", required=True, help="Destination backend path (file path or PostgreSQL DSN).")
    args = parser.parse_args()

    store = load_positions(args.from_path)
    save_positions(store, args.to_path)

    print(
        "Store sync complete: positions={positions}, research_rows={rows}".format(
            positions=len(list(iter_positions(store))),
            rows=len(store.get("research_rows", [])) if isinstance(store.get("research_rows", []), list) else 0,
        )
    )


if __name__ == "__main__":
    main()
