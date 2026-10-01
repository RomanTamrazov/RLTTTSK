#!/usr/bin/env python3
"""Обучить CatBoost ранжировать поставщиков внутри одного лота.

Вход: подготовленные строки «лот × поставщик» от prepare_catboost_data.py.
2024 год используется для обучения, 2025 год — для проверки по времени.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import numpy as np
import pandas as pd
from catboost import CatBoostRanker, Pool

from model_schema import CATEGORICAL, FEATURES, PRICE_CAP_EM, SCHEMA_VERSION


ROOT = Path(__file__).resolve().parent
SEED = 42
META_COLUMNS = ["lot_id", "supplier_inn", "publish_date", "purchase_channel", "label"]
ZERO_WHEN_NEW = [
    "history_participations", "history_wins",
    "category_participations", "category_wins",
    "buyer_participations", "buyer_wins", "buyer_category_wins",
]
NEUTRAL_WHEN_NEW = ["history_win_rate", "category_win_rate", "buyer_win_rate"]
UNKNOWN_AGE_WHEN_NEW = ["days_since_supplier_activity", "days_since_category_activity"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared", type=Path, default=ROOT / "prepared" / "training_features.csv.gz")
    parser.add_argument("--artifacts", type=Path, default=ROOT / "artifacts")
    parser.add_argument("--train-before", default="2025-01-01")
    parser.add_argument("--iterations", type=int, default=700)
    parser.add_argument("--depth", type=int, default=7)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--cold-share", type=float, default=0.10,
                        help="Доля обучающих лотов со скрытой историей поставщиков (0..1).")
    args = parser.parse_args()
    if not 0 <= args.cold_share <= 1:
        parser.error("--cold-share должен быть в диапазоне от 0 до 1")
    return args


def load_prepared(path: Path) -> pd.DataFrame:
    """Загружаем только колонки, которые нужны модели и оценке качества."""
    columns = list(dict.fromkeys(META_COLUMNS + FEATURES))
    frame = pd.read_csv(path, usecols=columns, dtype={
        "lot_id": str, "supplier_inn": str, "category_division": str, "purchase_channel": str,
    })
    if not frame["purchase_channel"].eq("ЭМ").all():
        raise ValueError("Обучающая таблица должна содержать только ЭМ: в АИС ГЗ нет проигравших.")
    frame = frame.drop(columns="purchase_channel")
    frame["publish_date"] = pd.to_datetime(frame["publish_date"], errors="raise")
    frame["label"] = frame["label"].astype("int8")
    frame[CATEGORICAL] = frame[CATEGORICAL].fillna("unknown").astype(str)
    for feature in FEATURES:
        if feature not in CATEGORICAL:
            frame[feature] = pd.to_numeric(frame[feature], errors="coerce").fillna(0)
    return frame


def eligible_rows(frame: pd.DataFrame) -> pd.DataFrame:
    """Оставляем лоты, где есть выбор: >=2 кандидатов и ровно один победитель."""
    per_lot = frame.groupby("lot_id")["label"].agg(candidates="size", winners="sum")
    eligible_ids = per_lot.index[(per_lot["candidates"] >= 2) & (per_lot["winners"] == 1)]
    return (frame[frame["lot_id"].isin(eligible_ids)]
            .sort_values(["lot_id", "supplier_inn"], kind="mergesort")
            .reset_index(drop=True))


def split_by_time(frame: pd.DataFrame, cutoff: pd.Timestamp) -> tuple[pd.DataFrame, pd.DataFrame]:
    train = eligible_rows(frame[frame["publish_date"] < cutoff])
    valid = eligible_rows(frame[frame["publish_date"] >= cutoff])
    if train.empty or valid.empty:
        raise ValueError("После временного разбиения нет обучающих или проверочных лотов.")
    return train, valid


def hide_history(frame: pd.DataFrame) -> pd.DataFrame:
    """Имитируем нового поставщика, оставляя текст и категорию доступными."""
    result = frame.copy()
    result[ZERO_WHEN_NEW] = 0
    result[NEUTRAL_WHEN_NEW] = 0.5
    result[UNKNOWN_AGE_WHEN_NEW] = 3650
    return result


def augment_cold_start(train: pd.DataFrame, share: float) -> pd.DataFrame:
    """Скрываем историю целыми лотами, чтобы не менять часть одной группы."""
    lot_ids = train["lot_id"].drop_duplicates().tolist()
    selected = set(random.Random(SEED).sample(lot_ids, int(len(lot_ids) * share)))
    augmented = train.copy()
    rows = augmented["lot_id"].isin(selected)
    augmented.loc[rows, ZERO_WHEN_NEW] = 0
    augmented.loc[rows, NEUTRAL_WHEN_NEW] = 0.5
    augmented.loc[rows, UNKNOWN_AGE_WHEN_NEW] = 3650
    return augmented


def make_pool(frame: pd.DataFrame) -> Pool:
    return Pool(frame[FEATURES], label=frame["label"],
                group_id=frame["lot_id"], cat_features=CATEGORICAL)


def ranking_metrics(frame: pd.DataFrame, scores: np.ndarray | pd.Series) -> dict:
    """Место единственного победителя в каждом лоте; frame уже отфильтрован."""
    scored = frame[["lot_id", "label"]].copy()
    scored["score"] = scores
    scored["rank"] = scored.groupby("lot_id")["score"].rank(method="first", ascending=False)
    ranks = scored.loc[scored["label"].eq(1), "rank"].to_numpy()
    discount = 1 / np.log2(ranks + 1)
    return {
        "eligible_lots": int(len(ranks)),
        "hit_rate_at_1": float(np.mean(ranks == 1)),
        "mrr": float(np.mean(1 / ranks)),
        "ndcg_at_5": float(np.mean(np.where(ranks <= 5, discount, 0))),
        "ndcg_at_10": float(np.mean(np.where(ranks <= 10, discount, 0))),
    }


def simple_history_score(frame: pd.DataFrame) -> pd.Series:
    """Прозрачный ориентир для сравнения с ML, а не модель для сайта."""
    return (2.0 * frame["category_win_rate"]
            + 0.35 * frame["buyer_win_rate"]
            + 0.20 * frame["history_win_rate"]
            + 0.10 * frame["text_similarity"]
            - 0.15 * frame["days_since_category_activity"] / 3650)


def train_model(train: pd.DataFrame, valid: pd.DataFrame,
                args: argparse.Namespace) -> tuple[CatBoostRanker, Pool]:
    train_pool = make_pool(train)
    model = CatBoostRanker(
        loss_function="YetiRankPairwise",
        eval_metric="NDCG:top=1",
        iterations=args.iterations,
        learning_rate=0.05,
        depth=args.depth,
        l2_leaf_reg=5.0,
        random_seed=SEED,
        thread_count=args.threads,
        allow_writing_files=False,
        verbose=100,
    )
    model.fit(train_pool, eval_set=make_pool(valid),
              early_stopping_rounds=60, use_best_model=True)
    return model, train_pool


def save_artifacts(model: CatBoostRanker, train_pool: Pool,
                   train: pd.DataFrame, valid: pd.DataFrame,
                   args: argparse.Namespace, cutoff: pd.Timestamp) -> dict:
    # Сначала считаем все показатели; файлы сохраняем только после успешной оценки.
    simple_metrics = ranking_metrics(valid, simple_history_score(valid))
    model_metrics = ranking_metrics(valid, model.predict(make_pool(valid)))
    cold_metrics = ranking_metrics(valid, model.predict(make_pool(hide_history(valid))))
    args.artifacts.mkdir(parents=True, exist_ok=True)
    model_path = args.artifacts / "supplier_ranker.cbm"
    importance_path = args.artifacts / "feature_importance.csv"

    report = {
        "model": "CatBoostRanker/YetiRankPairwise",
        "feature_schema_version": SCHEMA_VERSION,
        "price_cap_em_rub": PRICE_CAP_EM,
        "model_file": model_path.name,
        "training_period": f"до {cutoff.date()} (граница не включена)",
        "validation_period": f"с {cutoff.date()} по {valid['publish_date'].max().date()}",
        "train_lots": int(train["lot_id"].nunique()),
        "validation_lots": int(valid["lot_id"].nunique()),
        "metrics_definition": "Лоты с >=2 записанными участниками и ровно одним победителем; ранжирование только внутри этих участников.",
        "simple_rule": simple_metrics,
        "catboost": model_metrics,
        "cold_start_simulation": cold_metrics,
        "cold_start_training_group_share": args.cold_share,
        "best_iteration": int(model.get_best_iteration()),
        "features": FEATURES,
        "categorical_features": CATEGORICAL,
        "feature_importance_file": importance_path.name,
        "limitations": [
            "Метрика не измеряет полноту поиска компаний, отсутствующих в таблице исторических участников.",
            "2025 год используется для early stopping и сравнения вариантов; это validation, а не независимый финальный тест.",
            "Cold-start метрика симулирует поставщика с обнулённой историей среди известных участников; она не заменяет проверку на новых реальных компаниях.",
            "Для нового поставщика категория и текст профиля должны прийти из пула сайта.",
            "Статус, число предложений и регион из внешнего каталога показываются как проверяемые сигналы, но не входят в обученный score без исторических меток по этим полям.",
            "Обучение и метрики относятся к электронному магазину: в АИС ГЗ нет строк проигравших, поэтому его записи используются как кандидаты, а не как конкурентная разметка.",
            "Цена выше 600 000 ₽ в электронном магазине ограничивается для модели; исходное значение в CSV сохраняется без изменений.",
        ],
    }
    model.save_model(str(model_path), format="cbm")
    model.get_feature_importance(train_pool, prettified=True).to_csv(importance_path, index=False)
    (args.artifacts / "training_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def main() -> None:
    args = parse_args()
    print(f"Читаю подготовленную выборку {args.prepared}…", flush=True)
    frame = load_prepared(args.prepared)
    cutoff = pd.Timestamp(args.train_before)
    train, valid = split_by_time(frame, cutoff)
    print(f"Train: {len(train):,} строк / {train['lot_id'].nunique():,} лотов; "
          f"validation: {len(valid):,} строк / {valid['lot_id'].nunique():,} лотов", flush=True)
    model, train_pool = train_model(augment_cold_start(train, args.cold_share), valid, args)
    report = save_artifacts(model, train_pool, train, valid, args, cutoff)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
