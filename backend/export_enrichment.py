#!/usr/bin/env python3
"""Export verified FNS company data and public business contacts to D1."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.parse import quote

import pandas as pd

ROOT = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fns", type=Path, default=ROOT / "artifacts" / "fns_supplier_enrichment.csv.gz")
    parser.add_argument("--contacts", type=Path, default=ROOT / "artifacts" / "supplier_contacts.csv")
    parser.add_argument("--catalog", type=Path, default=ROOT / "artifacts" / "supplier_search_catalog.csv.gz")
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
    # Give every historical supplier a useful, date-bounded activity signal and
    # safe discovery links even when FNS or a public contact was not found.
    if args.catalog.exists():
        catalog = pd.read_csv(args.catalog, dtype=str, keep_default_na=False)
        for row in catalog.to_dict("records"):
            inn = str(row.get("supplier_inn", "")).strip()
            if len(inn) not in (10, 12) or not inn.isdigit() or inn.startswith("0000"):
                continue
            data = records.setdefault(inn, {})
            for source_key, target_key in (("last_activity", "last_activity"),
                                           ("observed_lots", "observed_lots"),
                                           ("ais_records", "ais_records"),
                                           ("em_records", "em_records")):
                if row.get(source_key):
                    data[target_key] = row[source_key]
            data.setdefault("activity_period", "2024–2025")
            data.setdefault("activity_source", "Архив закупок команды: 2024–2025")
            data.setdefault("contact_lookup_url", "https://yandex.ru/search/?text=" + quote(f"контакты компании ИНН {inn}"))
            data.setdefault("website_lookup_url", "https://yandex.ru/search/?text=" + quote(f"официальный сайт компании ИНН {inn}"))
            data.setdefault("portal_lookup_url", "https://zakupki.mos.ru/organization/list")
            data.setdefault("fns_registry_url", "https://egrul.nalog.ru/")
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
