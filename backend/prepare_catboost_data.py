#!/usr/bin/env python3
"""Build leakage-safe CatBoost ranking rows and serving-time supplier profiles."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
from model_schema import FEATURES, PRICE_CAP_EM
from text_features import overlap as lexical_overlap


ROOT = Path(__file__).resolve().parent
DATA_COLUMNS = ["lot_id", "supplier_inn", "label", "publish_date", "purchase_channel"] + FEATURES
ID_RE = re.compile(r"^\d{10}(?:\d\d)?$")


def read_inputs(data_dir: Path):
    notices = pd.read_csv(
        data_dir / "Извещения_24-25.csv", sep=";", dtype=str, usecols=[
            "publish_date", "lot_id", "start_price", "procedure_name",
            "subject", "customer_inn", "is_eshop_or_aisgz",
        ], keep_default_na=False,
    )
    notices["publish_date"] = pd.to_datetime(notices["publish_date"], errors="coerce")
    notices = notices.dropna(subset=["publish_date", "lot_id"]).drop_duplicates("lot_id")
    notices["customer_inn"] = notices["customer_inn"].str.strip()
    notices["purchase_text"] = (notices["procedure_name"].fillna("") + " " + notices["subject"].fillna("")).str.strip()
    notices["start_price_log"] = np.log1p(
        pd.to_numeric(notices["start_price"], errors="coerce").clip(lower=0, upper=PRICE_CAP_EM)
    )
    notices["purchase_channel"] = notices["is_eshop_or_aisgz"].replace("", "unknown").astype(str)

    suppliers = pd.read_csv(
        data_dir / "Поставщики_24-25.csv", sep=";", dtype=str,
        usecols=["lot_id", "supplier_inn", "is_winner"],
        keep_default_na=False,
    )
    suppliers["supplier_inn"] = suppliers["supplier_inn"].str.strip().str.strip('"')
    raw_supplier_rows = len(suppliers)
    valid_inn = suppliers["supplier_inn"].str.match(ID_RE, na=False)
    invalid_inn_rows = int((~valid_inn).sum())
    suppliers = suppliers[valid_inn].copy()
    suppliers["label"] = suppliers["is_winner"].str.lower().eq("true").astype("int8")
    duplicate_pairs = int(suppliers.duplicated(["lot_id", "supplier_inn"]).sum())
    suppliers = suppliers.drop_duplicates(["lot_id", "supplier_inn"])

    # Aggregate the 3M-row TРУ file incrementally; preserve the dominant section per lot.
    division_counts = defaultdict(Counter)
    tru_path = data_dir / "ТРУ_24-25.csv"
    for chunk in pd.read_csv(tru_path, sep=";", dtype=str, usecols=["lot_id", "okpd2_code"],
                             chunksize=250_000, keep_default_na=False):
        chunk["division"] = chunk["okpd2_code"].str.split(".", n=1).str[0]
        chunk = chunk[(chunk["lot_id"] != "") & (chunk["division"].str.fullmatch(r"\d{2}", na=False))]
        counts = chunk.groupby(["lot_id", "division"], sort=False).size()
        for (lot, division), count in counts.items():
            division_counts[lot][division] += int(count)
    categories = pd.DataFrame([
        {"lot_id": lot, "category_division": sorted(counts.items(), key=lambda x: (-x[1], x[0]))[0][0],
         "category_count": len(counts)}
        for lot, counts in division_counts.items()
    ])
    categories["category_division"] = categories["category_division"].astype(str)

    base = suppliers.merge(notices, on="lot_id", how="inner", validate="many_to_one")
    base = base.merge(categories, on="lot_id", how="left", validate="many_to_one")
    base["category_division"] = base["category_division"].fillna("unknown").astype(str)
    base = base.sort_values(["publish_date", "lot_id", "supplier_inn"], kind="mergesort").reset_index(drop=True)
    cleaning = {
        "raw_supplier_rows": int(raw_supplier_rows),
        "invalid_inn_rows_excluded": invalid_inn_rows,
        "duplicate_lot_supplier_rows_excluded": duplicate_pairs,
        "valid_supplier_rows_without_notice": int((~suppliers["lot_id"].isin(notices["lot_id"])).sum()),
        "joined_candidate_rows": int(len(base)),
    }
    return base, cleaning


def add_daily_history(base: pd.DataFrame, keys: list[str], prefix: str) -> pd.DataFrame:
    """For each entity/day, use only history strictly before that day."""
    daily = (base.groupby(keys + ["publish_date"], as_index=False, sort=False)
             .agg(day_participations=("label", "size"), day_wins=("label", "sum")))
    daily = daily.sort_values(keys + ["publish_date"], kind="mergesort")
    grouped = daily.groupby(keys, sort=False, dropna=False)
    daily[f"{prefix}_participations"] = grouped["day_participations"].cumsum() - daily["day_participations"]
    daily[f"{prefix}_wins"] = grouped["day_wins"].cumsum() - daily["day_wins"]
    daily[f"{prefix}_previous_day"] = grouped["publish_date"].shift(1)
    return daily[keys + ["publish_date", f"{prefix}_participations", f"{prefix}_wins", f"{prefix}_previous_day"]]


def previous_win_text(base: pd.DataFrame, keys: list[str]) -> pd.Series:
    """Описание последней победы строго до текущей даты для группы keys."""
    dates = keys + ["publish_date"]
    wins = (base[base["label"].eq(1)].sort_values(dates + ["lot_id"])
            .drop_duplicates(dates, keep="last")[dates + ["purchase_text"]])
    days = base[dates].drop_duplicates().merge(wins, on=dates, how="left").sort_values(dates)
    days["previous_text"] = days.groupby(keys)["purchase_text"].transform(lambda s: s.shift(1).ffill())
    return base[dates].merge(days[dates + ["previous_text"]], on=dates, how="left",
                            validate="many_to_one")["previous_text"].fillna("")


def prepare_features(base: pd.DataFrame) -> pd.DataFrame:
    base = base.copy()
    global_history = add_daily_history(base, ["supplier_inn"], "history")
    base = base.merge(global_history, on=["supplier_inn", "publish_date"], how="left", validate="many_to_one")

    known_buyer = base[base["customer_inn"].ne("")]
    buyer_history = add_daily_history(known_buyer, ["supplier_inn", "customer_inn"], "buyer")
    base = base.merge(buyer_history, on=["supplier_inn", "customer_inn", "publish_date"], how="left", validate="many_to_one")

    known_category = base[base["category_division"].ne("unknown")]
    category_history = add_daily_history(known_category, ["supplier_inn", "category_division"], "category")
    base = base.merge(category_history, on=["supplier_inn", "category_division", "publish_date"], how="left", validate="many_to_one")

    # Только прежние победы этого поставщика у этого заказчика в этой категории.
    known_buyer_category = base[base["customer_inn"].ne("") & base["category_division"].ne("unknown")]
    buyer_category_keys = ["supplier_inn", "customer_inn", "category_division"]
    buyer_category_history = add_daily_history(
        known_buyer_category, buyer_category_keys, "buyer_category"
    )
    base = base.merge(buyer_category_history[buyer_category_keys + ["publish_date", "buyer_category_wins"]],
                      on=buyer_category_keys + ["publish_date"], how="left", validate="many_to_one")

    count_columns = ["history_participations", "history_wins", "buyer_participations", "buyer_wins",
                     "buyer_category_wins", "category_participations", "category_wins"]
    base[count_columns] = base[count_columns].fillna(0).astype("int32")
    base["history_win_rate"] = (base["history_wins"] + 1) / (base["history_participations"] + 2)
    base["category_win_rate"] = (base["category_wins"] + 1) / (base["category_participations"] + 2)
    base["buyer_win_rate"] = (base["buyer_wins"] + 1) / (base["buyer_participations"] + 2)
    base["days_since_supplier_activity"] = (
        (base["publish_date"] - base["history_previous_day"]).dt.days.clip(lower=0, upper=3650).fillna(3650)
    ).astype("int16")
    base["category_code_match"] = base["category_participations"].gt(0).astype("int8")
    base["days_since_category_activity"] = (
        (base["publish_date"] - base["category_previous_day"]).dt.days.clip(lower=0, upper=3650).fillna(3650)
    ).astype("int16")
    global_text = previous_win_text(base, ["supplier_inn"])
    category_text = previous_win_text(base, ["supplier_inn", "category_division"])
    base["text_similarity"] = [max(lexical_overlap(q, g), lexical_overlap(q, c))
                               for q, g, c in zip(base["purchase_text"], global_text, category_text)]
    return base


def save_profiles(base: pd.DataFrame, output_dir: Path):
    """Save outcome profiles from the electronic store, where losing rows exist."""
    output_dir.mkdir(parents=True, exist_ok=True)
    global_profiles = (base.groupby("supplier_inn", as_index=False)
                       .agg(total_participations=("label", "size"), total_wins=("label", "sum"),
                            last_activity=("publish_date", "max")))
    global_profiles["total_win_rate"] = (global_profiles["total_wins"] + 1) / (global_profiles["total_participations"] + 2)
    last_win_text = (base[base["label"].eq(1)].sort_values(["supplier_inn", "publish_date", "lot_id"])
                     .drop_duplicates("supplier_inn", keep="last")[["supplier_inn", "purchase_text"]]
                     .rename(columns={"purchase_text": "last_win_text"}))
    global_profiles = global_profiles.merge(last_win_text, on="supplier_inn", how="left", validate="one_to_one")
    global_profiles.to_csv(output_dir / "supplier_global.csv.gz", index=False, compression="gzip")

    category_profiles = (base[base["category_division"].ne("unknown")]
                         .groupby(["supplier_inn", "category_division"], as_index=False)
                         .agg(category_participations=("label", "size"), category_wins=("label", "sum"),
                              last_category_activity=("publish_date", "max")))
    category_profiles["category_win_rate"] = (category_profiles["category_wins"] + 1) / (category_profiles["category_participations"] + 2)
    category_keys = ["supplier_inn", "category_division"]
    category_text = (base[base["label"].eq(1)].sort_values(["publish_date", "lot_id"])
                     .drop_duplicates(category_keys, keep="last")[category_keys + ["purchase_text"]]
                     .rename(columns={"purchase_text": "last_win_text"}))
    category_profiles = category_profiles.merge(category_text, on=category_keys, how="left", validate="one_to_one")
    category_profiles.to_csv(output_dir / "supplier_by_category.csv.gz", index=False, compression="gzip")

    buyer_profiles = (base[base["customer_inn"].ne("")]
                      .groupby(["supplier_inn", "customer_inn"], as_index=False)
                      .agg(buyer_participations=("label", "size"), buyer_wins=("label", "sum")))
    buyer_profiles["buyer_win_rate"] = (buyer_profiles["buyer_wins"] + 1) / (buyer_profiles["buyer_participations"] + 2)
    buyer_profiles.to_csv(output_dir / "supplier_by_buyer.csv.gz", index=False, compression="gzip")

    buyer_category_profiles = (base[base["customer_inn"].ne("") & base["category_division"].ne("unknown")]
                               .groupby(["supplier_inn", "customer_inn", "category_division"], as_index=False)
                               .agg(buyer_category_wins=("label", "sum")))
    buyer_category_profiles.to_csv(output_dir / "supplier_by_buyer_category.csv.gz",
                                   index=False, compression="gzip")


def save_search_catalog(base: pd.DataFrame, output_dir: Path):
    """Keep both channels as evidence that a supplier worked in a category."""
    known = base[base["category_division"].ne("unknown")].copy()
    known["ais_record"] = known["purchase_channel"].eq("АИС ГЗ").astype("int8")
    known["em_record"] = known["purchase_channel"].eq("ЭМ").astype("int8")
    keys = ["supplier_inn", "category_division"]
    counts = (known.groupby(keys, as_index=False)
              .agg(observed_lots=("lot_id", "nunique"),
                   ais_records=("ais_record", "sum"),
                   em_records=("em_record", "sum"),
                   last_activity=("publish_date", "max")))
    recent = (known.sort_values(["publish_date", "lot_id"], ascending=False, kind="mergesort")
              .drop_duplicates(keys + ["purchase_text"])
              .groupby(keys, sort=False).head(4))
    examples = (recent.groupby(keys, as_index=False, sort=False)["purchase_text"]
                .agg(list).rename(columns={"purchase_text": "examples"}))
    examples["example_text"] = examples["examples"].str[0]
    examples["examples_json"] = examples["examples"].map(lambda values: json.dumps(values, ensure_ascii=False))
    catalog = counts.merge(examples.drop(columns="examples"), on=keys, how="left", validate="one_to_one")
    catalog.to_csv(output_dir / "supplier_search_catalog.csv.gz", index=False, compression="gzip")
    return len(catalog)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT.parent.parent)
    parser.add_argument("--prepared", type=Path, default=ROOT / "prepared")
    parser.add_argument("--artifacts", type=Path, default=ROOT / "artifacts")
    args = parser.parse_args()

    print("Загрузка CSV и объединение по lot_id через pandas…", flush=True)
    base, cleaning = read_inputs(args.data_dir)
    # AИС ГЗ has no losing rows in the supplied file. Its records are useful as
    # supplier/category evidence, but cannot estimate a competitive win rate.
    training_base = base[base["purchase_channel"].eq("ЭМ")].copy()
    print(f"Подготовка истории ЭМ для {len(training_base):,} связей поставщик–лот…", flush=True)
    features = prepare_features(training_base)
    args.prepared.mkdir(parents=True, exist_ok=True)
    features[DATA_COLUMNS].to_csv(args.prepared / "training_features.csv.gz", index=False, compression="gzip")
    save_profiles(training_base, args.artifacts)
    catalog_rows = save_search_catalog(base, args.artifacts)
    summary = {
        "all_channel_candidate_rows": int(len(base)),
        "candidate_rows": int(len(features)),
        "distinct_lots": int(features["lot_id"].nunique()),
        "distinct_suppliers": int(features["supplier_inn"].nunique()),
        "cleaning": cleaning,
        "date_min": str(features["publish_date"].min().date()),
        "date_max": str(features["publish_date"].max().date()),
        "label_positive_rate": float(features["label"].mean()),
        "prepared_file": str(args.prepared / "training_features.csv.gz"),
        "training_channel": "ЭМ",
        "search_catalog_rows": int(catalog_rows),
        "profile_files": ["supplier_global.csv.gz", "supplier_by_category.csv.gz", "supplier_by_buyer.csv.gz",
                          "supplier_by_buyer_category.csv.gz", "supplier_search_catalog.csv.gz"],
    }
    (args.prepared / "data_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
