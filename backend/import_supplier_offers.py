#!/usr/bin/env python3
"""Merge reviewed Import.io/Yandex-parser exports into the supplier pool.

This is deliberately an import step, not an unattended crawler: every source
row must carry a supplier INN, capture date, HTTPS evidence URL, and
verified=true after a human has checked that the page belongs to that company.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
POOL = ROOT / "artifacts" / "external_supplier_pool.csv"
DATE_FIELDS = ("checked_date", "offer_checked_date", "contact_checked_date", "captured_at")
ALIASES = {
    "supplier_inn": ("supplier_inn", "inn", "company_inn", "ИНН"),
    "supplier_name": ("supplier_name", "company_name", "name", "Наименование"),
    "okpd2_codes": ("okpd2_codes", "okpd2", "OKPD2", "ОКПД2"),
    "profile_text": ("profile_text", "description", "snippet", "Описание"),
    "source_url": ("source_url", "url", "source", "Ссылка"),
    "checked_date": ("checked_date", "offer_checked_date", "contact_checked_date", "captured_at", "checked_at"),
    "offer_title": ("offer_title", "product", "product_name", "title", "Товар"),
    "offer_price": ("offer_price", "price", "Цена"),
    "offer_price_unit": ("offer_price_unit", "price_unit", "unit", "Единица цены"),
    "offer_price_note": ("offer_price_note", "price_note", "Условия цены"),
    "offer_availability": ("offer_availability", "availability", "stock", "Наличие"),
    "contact_phone": ("contact_phone", "phone", "telephone", "Телефон"),
    "contact_email": ("contact_email", "email", "e-mail", "Почта"),
    "website": ("website", "site", "domain", "Сайт"),
    "contact_url": ("contact_url", "contacts_url", "Страница контактов"),
    "verified": ("verified", "reviewed", "проверено"),
}
OUTPUT_FIELDS = {
    "supplier_name", "okpd2_codes", "profile_text", "source_url", "checked_date", "offer_title", "offer_price", "offer_price_unit",
    "offer_price_note", "offer_availability", "offer_url", "offer_checked_date", "contact_phone",
    "contact_email", "website", "contact_url", "contact_checked_date", "contact_source",
}


def canonicalize(row: dict) -> dict[str, str]:
    source = {str(k).strip().lower(): str(v).strip() for k, v in row.items() if v is not None}
    result = {}
    for target, names in ALIASES.items():
        for name in names:
            if name.lower() in source and source[name.lower()]:
                result[target] = source[name.lower()]
                break
    return result


def read_rows(path: Path) -> list[dict]:
    if path.suffix.lower() == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            payload = payload.get("results", payload.get("items", payload.get("data", [])))
        if not isinstance(payload, list):
            raise ValueError("JSON должен содержать список записей или поле results/items/data.")
        return payload
    with path.open(encoding="utf-8-sig", newline="") as source:
        sample = source.read(4096)
        source.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        return list(csv.DictReader(source, dialect=dialect))


def capture_date(row: dict[str, str]) -> date:
    raw = next((row.get(name, "") for name in DATE_FIELDS if row.get(name)), "")
    if not raw:
        raise ValueError("нет даты проверки (checked_date / captured_at)")
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
    except ValueError:
        parsed = date.fromisoformat(raw[:10])
    today = date.today()
    try:
        cutoff = today.replace(year=today.year - 3)
    except ValueError:  # leap day
        cutoff = today.replace(year=today.year - 3, day=28)
    if parsed < cutoff:
        raise ValueError(f"источник старше 36 месяцев ({parsed.isoformat()})")
    if parsed > today + timedelta(days=30):
        raise ValueError(f"дата из будущего ({parsed.isoformat()})")
    return parsed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="CSV/JSON export with reviewed supplier rows")
    parser.add_argument("--pool", type=Path, default=POOL, help="supplier pool CSV")
    parser.add_argument("--dry-run", action="store_true", help="validate without writing")
    args = parser.parse_args()

    with args.pool.open(encoding="utf-8-sig", newline="") as source:
        pool_rows = list(csv.DictReader(source))
        fieldnames = list(pool_rows[0]) if pool_rows else []
    by_inn = {row.get("supplier_inn", "").strip(): row for row in pool_rows}
    accepted, rejected = 0, []
    for number, raw in enumerate(read_rows(args.input), 2):
        try:
            if not isinstance(raw, dict):
                raise ValueError("запись должна быть объектом с полями")
            record = canonicalize(raw)
            inn = record.get("supplier_inn", "")
            if not inn.isdigit() or len(inn) not in (10, 12):
                raise ValueError("не найден корректный ИНН поставщика")
            if record.get("verified", "").lower() not in {"true", "yes", "1", "да"}:
                raise ValueError("поставьте verified=true после проверки соответствия страницы поставщику")
            checked = capture_date(record)
            source_url = record.get("source_url", "")
            if urlparse(source_url).scheme != "https" or not urlparse(source_url).netloc:
                raise ValueError("нужна HTTPS-ссылка на страницу-источник")
            if record.get("okpd2_codes"):
                try:
                    codes = json.loads(record["okpd2_codes"])
                except json.JSONDecodeError:
                    codes = [part.strip() for part in record["okpd2_codes"].replace(";", ",").split(",") if part.strip()]
                if isinstance(codes, str):
                    codes = [codes]
                if not isinstance(codes, list) or not codes or any(not re.fullmatch(r"\d{2}(?:\.\d{1,3}){0,4}", str(code)) for code in codes):
                    raise ValueError("okpd2_codes должен содержать подтверждённые коды через запятую или JSON-список")
                record["okpd2_codes"] = json.dumps(codes, ensure_ascii=False)
            supplier = by_inn.get(inn)
            if supplier is None:
                if not record.get("supplier_name") or not record.get("okpd2_codes"):
                    raise ValueError("для нового поставщика нужны supplier_name и подтверждённый okpd2_codes")
                supplier = {key: "" for key in fieldnames}
                supplier.update(supplier_inn=inn, supplier_name=record["supplier_name"], okpd2_codes=record["okpd2_codes"],
                                profile_text=record.get("profile_text", record.get("offer_title", record["supplier_name"])), source="Проверенный импорт внешних данных",
                                source_url=source_url, history_status="unknown_not_found_in_2024_2025_dataset", checked_date=checked.isoformat())
                by_inn[inn] = supplier
                pool_rows.append(supplier)
            output = {k: v for k, v in record.items() if k in OUTPUT_FIELDS and v}
            if any(k.startswith("offer_") for k in output):
                output["offer_url"] = source_url
                output["offer_checked_date"] = checked.isoformat()
            if any(k in output for k in ("contact_phone", "contact_email", "website", "contact_url")):
                output["contact_source"] = source_url
                output["contact_checked_date"] = checked.isoformat()
            supplier.update(output)
            supplier["source_url"] = source_url
            supplier["checked_date"] = checked.isoformat()
            supplier["source"] = "Проверенный импорт внешних данных"
            accepted += 1
        except (ValueError, TypeError) as error:
            rejected.append((number, str(error)))
    if rejected:
        print(f"Отклонено записей: {len(rejected)}")
        for row_number, reason in rejected:
            print(f"строка {row_number}: {reason}")
    print(f"Принято проверенных записей: {accepted}; поставщиков в пуле: {len(pool_rows)}")
    if accepted and not args.dry_run:
        for field in OUTPUT_FIELDS:
            if field not in fieldnames:
                fieldnames.append(field)
        with args.pool.open("w", encoding="utf-8-sig", newline="") as output:
            writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction="ignore", lineterminator="\n")
            writer.writeheader()
            writer.writerows(pool_rows)
        print(f"Обновлён: {args.pool}")
    if rejected:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
