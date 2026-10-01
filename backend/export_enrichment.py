#!/usr/bin/env python3
"""Export verified FNS company data and public business contacts to D1."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fns", type=Path, default=ROOT / "artifacts" / "fns_supplier_enrichment.csv.gz")
    parser.add_argument("--contacts", type=Path, default=ROOT / "artifacts" / "supplier_contacts.csv")
    parser.add_argument("--output", type=Path, default=ROOT.parent / "cloudflare" / "generated" / "enrichment.sql")
    args = parser.parse_args()
    records: dict[str, dict[str, str]] = {}
    for path in (args.fns, args.contacts):
        if not path.exists():
            continue
        for row in pd.read_csv(path, dtype=str, keep_default_na=False).to_dict("records"):
            inn = row.pop("supplier_inn")
            if len(inn) not in (10, 12) or not inn.isdigit():
                raise ValueError(f"Invalid INN {inn!r} in {path}")
            records.setdefault(inn, {}).update({key: value for key, value in row.items() if value})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as output:
        output.write("DELETE FROM store WHERE key >= 'e:' AND key < 'e;';\n")
        for inn, data in sorted(records.items()):
            encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
            if len(encoded.encode("utf-8")) > 14000:
                raise ValueError(f"Enrichment for {inn} exceeds D1 row limit")
            output.write(f"INSERT OR REPLACE INTO store(key,value) VALUES ('e:{inn}:00000','{encoded.replace(chr(39), chr(39) * 2)}');\n")
    print(f"Exported {len(records)} company profiles to {args.output}")


if __name__ == "__main__":
    main()
