#!/usr/bin/env python3
"""Match the official FNS SME XML snapshot to supplier INNs in our catalog."""

from __future__ import annotations

import argparse
import csv
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import pandas as pd

ROOT = Path(__file__).resolve().parent
SOURCE = "https://www.nalog.gov.ru/opendata/7707329152-rsmp/"
FIELDS = ["supplier_inn", "supplier_name", "region", "city", "primary_okved",
          "msp_category", "staff_count", "snapshot_date", "source_url"]


def supplier_inns(artifacts: Path) -> set[str]:
    inns = set(pd.read_csv(artifacts / "supplier_search_catalog.csv.gz", usecols=["supplier_inn"],
                           dtype=str)["supplier_inn"])
    external = artifacts / "external_supplier_pool.csv"
    if external.exists():
        inns.update(pd.read_csv(external, usecols=["supplier_inn"], dtype=str)["supplier_inn"])
    return {inn for inn in inns if len(inn) in (10, 12) and inn.isdigit() and not inn.startswith("0000")}


def local_name(location: ET.Element | None, field: str) -> str:
    if location is None:
        return ""
    item = location.find(field)
    return item.get("Наим", "") if item is not None else ""


def record_from_document(doc: ET.Element) -> dict[str, str] | None:
    org = doc.find("ОргВклМСП")
    ip = doc.find("ИПВклМСП")
    if org is not None:
        inn = org.get("ИННЮЛ", "")
        name = org.get("НаимОргСокр") or org.get("НаимОрг", "")
    elif ip is not None:
        inn = ip.get("ИННФЛ", "")
        fio = ip.find("ФИОИП")
        name = "ИП " + " ".join(fio.get(k, "") for k in ("Фамилия", "Имя", "Отчество")).strip() if fio is not None else ""
    else:
        return None
    location = doc.find("СведМН")
    okved = doc.find("СвОКВЭД/СвОКВЭДОсн")
    return {"supplier_inn": inn, "supplier_name": name, "region": local_name(location, "Регион"),
            "city": local_name(location, "Город") or local_name(location, "НаселПункт"),
            "primary_okved": okved.get("КодОКВЭД", "") if okved is not None else "",
            "msp_category": doc.get("КатСубМСП", ""), "staff_count": doc.get("ССЧР", ""),
            "snapshot_date": doc.get("ДатаСост", ""), "source_url": SOURCE}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--artifacts", type=Path, default=ROOT / "artifacts")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts" / "fns_supplier_enrichment.csv.gz")
    args = parser.parse_args()
    wanted = supplier_inns(args.artifacts)
    found = {}
    with zipfile.ZipFile(args.archive) as archive:
        members = [name for name in archive.namelist() if name.endswith(".xml")]
        for index, name in enumerate(members, 1):
            with archive.open(name) as source:
                root = ET.parse(source).getroot()
            for doc in root.findall("Документ"):
                row = record_from_document(doc)
                if row and row["supplier_inn"] in wanted:
                    found[row["supplier_inn"]] = row
            if index % 500 == 0:
                print(f"{index}/{len(members)} XML; matches {len(found)}", flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(found.values(), columns=FIELDS).sort_values("supplier_inn").to_csv(
        args.output, index=False, compression="gzip", quoting=csv.QUOTE_MINIMAL)
    print(f"Matched {len(found)} of {len(wanted)} supplier INNs: {args.output}", flush=True)


if __name__ == "__main__":
    main()
