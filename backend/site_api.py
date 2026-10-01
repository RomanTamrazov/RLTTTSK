#!/usr/bin/env python3
"""FastAPI inference endpoint for the trained CatBoost supplier ranker."""

from __future__ import annotations

import os
import re
import csv
import json
from collections import defaultdict
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd
from catboost import CatBoostRanker
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from model_schema import CATEGORICAL as CAT_FEATURES, FEATURES, PRICE_CAP_EM, SCHEMA_VERSION
from query_parser import parse_search_query
from text_features import overlap as _overlap, tokens as _search_tokens


ROOT = Path(__file__).resolve().parent
ARTIFACTS = Path(os.getenv("RECOMMENDER_ARTIFACTS", ROOT / "artifacts"))
MODEL_FILE = ARTIFACTS / "supplier_ranker.cbm"
INN_RE = re.compile(r"^\d{10}(?:\d\d)?$")

app = FastAPI(title="Supplier Recommender API", version="0.1.0")


class Candidate(BaseModel):
    supplier_inn: str
    supplier_name: str = ""
    okpd2_codes: list[str] = Field(default_factory=list)
    profile_text: str = ""
    source: str = ""
    source_url: str = ""
    portal_status: str = ""
    portal_offer_count: int | None = None
    offer_region_match: bool | None = None
    portal_category_match: bool | None = None
    observed_lots: int | None = None


class RecommendationRequest(BaseModel):
    purchase_text: str
    okpd2_codes: list[str] = Field(default_factory=list)
    category_division: str | None = None
    category_count: int = 1
    customer_inn: str = ""
    start_price: float | None = None
    top_k: int = Field(default=20, ge=1, le=100)
    candidates: list[Candidate]


class SearchRequest(BaseModel):
    query: str = Field(min_length=2)
    okpd2_code: str = ""
    customer_inn: str = ""
    start_price: float | None = None
    top_k: int = Field(default=10, ge=1, le=30)


def _divisions(codes):
    result = []
    for code in codes:
        part = str(code).strip().split(".", 1)[0]
        if re.fullmatch(r"\d{2}", part) and part not in result:
            result.append(part)
    return result


@lru_cache(maxsize=1)
def _load_search_catalog():
    path = ARTIFACTS / "supplier_search_catalog.csv.gz"
    if not path.exists():
        raise FileNotFoundError(f"Не найден поисковый каталог поставщиков: {path}")
    catalog = pd.read_csv(path, dtype={"supplier_inn": str, "category_division": str}, keep_default_na=False)
    missing = {"supplier_inn", "category_division", "examples_json", "observed_lots", "ais_records", "em_records"} - set(catalog.columns)
    if missing:
        raise RuntimeError(f"Поисковый каталог устарел, не хватает полей: {sorted(missing)}")
    prepared = []
    for row in catalog.to_dict("records"):
        examples = json.loads(row.get("examples_json") or "[]")
        prepared.append((row, [(example, _search_tokens(example)) for example in examples]))
    return prepared


def _external_candidates(query_tokens: frozenset[str], division: str,
                         supplier_inn: str = "") -> list[Candidate]:
    path = ARTIFACTS / "external_supplier_pool.csv"
    if not path.exists():
        return []
    results = []
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if not INN_RE.fullmatch(row.get("supplier_inn", "")):
                continue
            if supplier_inn and row["supplier_inn"] != supplier_inn:
                continue
            try:
                codes = json.loads(row.get("okpd2_codes") or "[]")
            except json.JSONDecodeError:
                continue
            if division and division not in _divisions(codes):
                continue
            required = min(2, len(query_tokens))
            if not supplier_inn and len(query_tokens & _search_tokens(row.get("profile_text", ""))) < required:
                continue
            results.append(Candidate(
                supplier_inn=row["supplier_inn"], supplier_name=row.get("supplier_name", ""),
                okpd2_codes=codes, profile_text=row.get("profile_text", ""),
                source=row.get("source", ""), source_url=row.get("source_url", ""),
                portal_status=row.get("portal_status", ""),
                portal_offer_count=int(row["portal_offer_count"]) if row.get("portal_offer_count") else None,
                offer_region_match=row.get("offer_region_match") == "true",
                portal_category_match=row.get("portal_category_match") == "true",
            ))
    return results


@lru_cache(maxsize=1)
def _load_artifacts():
    if not MODEL_FILE.exists():
        raise FileNotFoundError(f"Не найдена CatBoost-модель: {MODEL_FILE}")
    required = ["supplier_global.csv.gz", "supplier_by_category.csv.gz", "supplier_by_buyer.csv.gz",
                "supplier_by_buyer_category.csv.gz"]
    missing = [name for name in required if not (ARTIFACTS / name).exists()]
    if missing:
        raise FileNotFoundError(f"Не найдены профили поставщиков: {missing}")
    model = CatBoostRanker()
    model.load_model(str(MODEL_FILE), format="cbm")
    if model.feature_names_ != FEATURES:
        raise RuntimeError("Схема признаков модели не совпадает с API. Переобучите модель.")
    report_path = ARTIFACTS / "training_report.json"
    if not report_path.exists() or json.loads(report_path.read_text(encoding="utf-8")).get("feature_schema_version") != SCHEMA_VERSION:
        raise RuntimeError("Версия признаков модели не совпадает с API. Переобучите модель.")

    global_df = pd.read_csv(ARTIFACTS / required[0], dtype={"supplier_inn": str}, keep_default_na=False)
    category_df = pd.read_csv(ARTIFACTS / required[1], dtype={"supplier_inn": str, "category_division": str}, keep_default_na=False)
    if "last_win_text" not in category_df:
        raise RuntimeError("Профили категорий устарели. Подготовьте данные заново.")
    buyer_df = pd.read_csv(ARTIFACTS / required[2], dtype={"supplier_inn": str, "customer_inn": str})
    buyer_category_df = pd.read_csv(ARTIFACTS / required[3], dtype={
        "supplier_inn": str, "customer_inn": str, "category_division": str,
    })
    globals_by_supplier = global_df.set_index("supplier_inn").to_dict("index")
    categories_by_supplier = {
        (row["supplier_inn"], row["category_division"]): row
        for row in category_df.to_dict("records")
    }
    buyers_by_pair = {
        (row["supplier_inn"], row["customer_inn"]): row
        for row in buyer_df.to_dict("records")
    }
    buyer_categories = {
        (row["supplier_inn"], row["customer_inn"], row["category_division"]): row
        for row in buyer_category_df.to_dict("records")
    }
    return model, globals_by_supplier, categories_by_supplier, buyers_by_pair, buyer_categories


def _activity_age(value):
    if not value:
        return 3650
    return min(max((pd.Timestamp.now().normalize() - pd.Timestamp(value)).days, 0), 3650)


def _feature_row(request: RecommendationRequest, candidate: Candidate, main_division: str,
                 model_profiles):
    _, globals_by_supplier, categories_by_supplier, buyers_by_pair, buyer_categories = model_profiles
    global_profile = globals_by_supplier.get(candidate.supplier_inn, {})
    category = categories_by_supplier.get((candidate.supplier_inn, main_division), {})
    buyer = buyers_by_pair.get((candidate.supplier_inn, request.customer_inn), {}) if request.customer_inn else {}
    buyer_category = buyer_categories.get((candidate.supplier_inn, request.customer_inn, main_division), {}) if request.customer_inn else {}
    candidate_divisions = _divisions(candidate.okpd2_codes)
    profile_text = candidate.profile_text or str(global_profile.get("last_win_text", ""))
    category_match = main_division in candidate_divisions or bool(category)
    general_text = global_profile.get("last_win_text", candidate.profile_text)
    category_text = category.get("last_win_text", candidate.profile_text)
    history_n = int(global_profile.get("total_participations", 0))
    category_n = int(category.get("category_participations", 0))
    buyer_n = int(buyer.get("buyer_participations", 0))
    row = {
        "history_participations": history_n,
        "history_wins": int(global_profile.get("total_wins", 0)),
        "history_win_rate": float(global_profile.get("total_win_rate", 0.5)),
        "history_rate_confidence": history_n / (history_n + 10.0),
        "days_since_supplier_activity": _activity_age(global_profile.get("last_activity")),
        "category_participations": category_n,
        "category_wins": int(category.get("category_wins", 0)),
        "category_win_rate": float(category.get("category_win_rate", 0.5)),
        "category_rate_confidence": category_n / (category_n + 5.0),
        "category_code_match": int(category_match),
        "days_since_category_activity": _activity_age(category.get("last_category_activity")),
        "buyer_participations": buyer_n,
        "buyer_wins": int(buyer.get("buyer_wins", 0)),
        "buyer_win_rate": float(buyer.get("buyer_win_rate", 0.5)),
        "buyer_category_wins": int(buyer_category.get("buyer_category_wins", 0)),
        "buyer_rate_confidence": buyer_n / (buyer_n + 5.0),
        "start_price_log": float(np.log1p(min(max(0.0, request.start_price or 0.0), PRICE_CAP_EM))),
        "text_similarity": max(_overlap(request.purchase_text, general_text),
                               _overlap(request.purchase_text, category_text)),
        "category_count": max(0, int(request.category_count)),
        "category_division": main_division or "unknown",
    }
    return row, category_match, profile_text


@app.get("/health")
def health():
    try:
        _load_artifacts()
        _load_search_catalog()
    except (FileNotFoundError, RuntimeError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"status": "ok", "model": MODEL_FILE.name, "feature_schema_version": SCHEMA_VERSION}


@app.post("/recommend")
def recommend(request: RecommendationRequest):
    if not request.candidates:
        raise HTTPException(status_code=422, detail="Передайте список candidates от каталога/источника поставщиков.")
    invalid = [c.supplier_inn for c in request.candidates if not INN_RE.fullmatch(c.supplier_inn)]
    if invalid:
        raise HTTPException(status_code=422, detail=f"Некорректный ИНН у кандидатов: {invalid[:5]}")
    if len({c.supplier_inn for c in request.candidates}) != len(request.candidates):
        raise HTTPException(status_code=422, detail="Каждый supplier_inn должен встречаться в candidates один раз.")
    model_profiles = _load_artifacts()
    main_division = request.category_division or next(iter(_divisions(request.okpd2_codes)), "unknown")
    rows = []
    explanations = {}
    for candidate in request.candidates:
        row, category_match, profile_text = _feature_row(request, candidate, main_division, model_profiles)
        rows.append(row)
        reasons = []
        if category_match:
            reasons.append("профиль поставщика совпадает с разделом ОКПД2")
        if row["category_participations"]:
            reasons.append(f"участвовал в этой категории {row['category_participations']} раз, побед {row['category_wins']}")
        if row["buyer_participations"]:
            reasons.append(f"есть {row['buyer_participations']} прошлых участий у заказчика, побед {row['buyer_wins']}")
        if row["buyer_category_wins"]:
            reasons.append(f"побед у этого заказчика в данной категории: {row['buyer_category_wins']}")
        if row["text_similarity"] >= 0.15:
            reasons.append("описание опыта или профиля похоже на предмет закупки")
        if row["history_participations"] and row["history_rate_confidence"] < 0.5:
            reasons.append("исторический процент побед пока подтверждён небольшим числом участий")
        if row["history_participations"] == 0:
            if candidate.observed_lots:
                reasons.append("есть записи закупок, но нет истории конкурентных результатов ЭМ")
            else:
                reasons.append("нет истории в этих данных; оценка основана на профиле кандидата")
        elif not reasons:
            reasons.append("ранг рассчитан по общей истории участий и побед")
        if candidate.portal_status:
            reasons.append(f"статус в портале: {candidate.portal_status}")
        if candidate.portal_offer_count:
            reasons.append(f"в профиле портала опубликовано предложений: {candidate.portal_offer_count}")
        if candidate.offer_region_match:
            reasons.append("портал подтверждает регион поставки для этой закупки")
        if candidate.portal_category_match:
            reasons.append("в каталоге портала найдено совпадение товарной категории")
        if candidate.observed_lots:
            reasons.append(f"в архиве найдено закупок в этой категории: {candidate.observed_lots}")
        explanations[candidate.supplier_inn] = (candidate, reasons, row, profile_text)
    features = pd.DataFrame(rows, columns=FEATURES)
    for column in CAT_FEATURES:
        features[column] = features[column].fillna("unknown").astype(str)
    scores = model_profiles[0].predict(features)
    ordered = sorted(zip(request.candidates, scores), key=lambda item: float(item[1]), reverse=True)[:request.top_k]
    recommendations = []
    for rank, (candidate, score) in enumerate(ordered, start=1):
        _, reasons, row, profile_text = explanations[candidate.supplier_inn]
        recommendations.append({
            "rank": rank,
            "supplier_inn": candidate.supplier_inn,
            "supplier_name": candidate.supplier_name,
            "profile_excerpt": profile_text[:280],
            "category_division": main_division,
            "rank_score": float(score),
            "source": candidate.source,
            "source_url": candidate.source_url,
            "reasons": reasons,
            "history": {
                "participations": row["history_participations"],
                "wins": row["history_wins"],
                "rate_confidence": row["history_rate_confidence"],
                "days_since_activity": row["days_since_supplier_activity"],
                "category_participations": row["category_participations"],
                "category_wins": row["category_wins"],
                "category_rate_confidence": row["category_rate_confidence"],
                "buyer_participations": row["buyer_participations"],
                "buyer_wins": row["buyer_wins"],
                "buyer_category_wins": row["buyer_category_wins"],
                "buyer_rate_confidence": row["buyer_rate_confidence"],
            },
            "quality_signals": {
                "category_match": bool(row["category_code_match"]),
                "text_similarity": row["text_similarity"],
                "history_confidence": row["history_rate_confidence"],
                "days_since_activity": row["days_since_supplier_activity"],
                "portal_status": candidate.portal_status or None,
                "portal_offer_count": candidate.portal_offer_count,
                "offer_region_match": candidate.offer_region_match,
                "portal_category_match": candidate.portal_category_match,
                "observed_lots": candidate.observed_lots,
            },
        })
    return {"candidate_count": len(request.candidates), "rank_score_is_probability": False,
            "recommendations": recommendations}


@app.post("/search")
def search(request: SearchRequest):
    """Разобрать одну строку, найти кандидатов и передать их CatBoost."""
    try:
        parsed = parse_search_query(request.query)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if request.okpd2_code and parsed.okpd2_code and request.okpd2_code != parsed.okpd2_code:
        raise HTTPException(status_code=422, detail="Коды ОКПД2 в строке и отдельном поле различаются.")
    if request.customer_inn and parsed.customer_inn and request.customer_inn != parsed.customer_inn:
        raise HTTPException(status_code=422, detail="ИНН заказчика в строке и отдельном поле различаются.")

    code = request.okpd2_code or parsed.okpd2_code
    customer_inn = request.customer_inn or parsed.customer_inn
    supplier_inn = parsed.supplier_inn
    if customer_inn and not INN_RE.fullmatch(customer_inn):
        raise HTTPException(status_code=422, detail="ИНН заказчика должен содержать 10 или 12 цифр.")
    explicit_division = next(iter(_divisions([code])), "") if code else ""
    if code and not explicit_division:
        raise HTTPException(status_code=422, detail="Укажите код ОКПД2, который начинается с двух цифр.")
    query_tokens = _search_tokens(parsed.purchase_text)
    if not query_tokens and not explicit_division and not supplier_inn:
        raise HTTPException(status_code=422, detail="Укажите предмет закупки, код ОКПД2 или ИНН поставщика.")
    mode = "supplier_lookup" if supplier_inn else "category_browse" if not query_tokens else "recommendations"
    parsed_query = {"purchase_text": parsed.purchase_text, "okpd2_code": code or None,
                    "customer_inn": customer_inn or None, "supplier_inn": supplier_inn or None}

    matches = []
    required = min(2, len(query_tokens))
    for row, examples in _load_search_catalog():
        if supplier_inn and row["supplier_inn"] != supplier_inn:
            continue
        if explicit_division and row["category_division"] != explicit_division:
            continue
        best_relevance, best_example = 0.0, ""
        if query_tokens:
            for example, tokens in examples:
                common = len(query_tokens & tokens)
                if common >= required:
                    relevance = common / float(np.sqrt(len(query_tokens) * max(len(tokens), 1)))
                    if relevance > best_relevance:
                        best_relevance, best_example = relevance, example
        if not best_example and (supplier_inn or not query_tokens):
            best_example = examples[0][0] if examples else row.get("example_text", "")
        if best_example:
            matches.append((best_relevance, row, best_example))
    matches.sort(key=lambda item: (item[0], int(item[1]["observed_lots"])), reverse=True)

    if explicit_division:
        division = explicit_division
    elif supplier_inn or not query_tokens:
        division = matches[0][1]["category_division"] if matches else ""
    else:
        by_division = defaultdict(list)
        for relevance, row, _ in matches[:80]:
            by_division[row["category_division"]].append(relevance)
        division = max(by_division, key=lambda code: sum(sorted(by_division[code], reverse=True)[:3])) if by_division else ""

    pool: dict[str, Candidate] = {}
    for _, row, best_example in matches:
        if row["category_division"] != division:
            continue
        inn = row["supplier_inn"]
        if not INN_RE.fullmatch(inn) or inn.startswith("0000") or inn in pool:
            continue
        channels = []
        if int(row["em_records"]):
            channels.append("ЭМ")
        if int(row["ais_records"]):
            channels.append("АИС ГЗ")
        pool[inn] = Candidate(
            supplier_inn=inn, okpd2_codes=[division],
            profile_text=best_example,
            source="История закупок: " + ", ".join(channels),
            observed_lots=int(row["observed_lots"]),
        )
        if len(pool) >= 300:
            break
    for candidate in _external_candidates(query_tokens, division, supplier_inn):
        pool[candidate.supplier_inn] = candidate
    if supplier_inn and not pool:
        # История ЭМ может содержать ИНН без распознанного раздела ОКПД2.
        global_profile = _load_artifacts()[1].get(supplier_inn)
        if global_profile:
            last_text = global_profile.get("last_win_text", "")
            pool[supplier_inn] = Candidate(
                supplier_inn=supplier_inn,
                profile_text="" if pd.isna(last_text) else str(last_text),
                source="История закупок: ЭМ",
            )
    if not division and pool:
        division = next(iter(_divisions(next(iter(pool.values())).okpd2_codes)), "")

    if not pool:
        return {"query": request.query, "category_division": division or None,
                "category_inferred": not bool(explicit_division), "mode": mode,
                "parsed_query": parsed_query, "candidate_count": 0,
                "rank_score_is_probability": False, "recommendations": []}
    ranked = recommend(RecommendationRequest(
        purchase_text=parsed.purchase_text, okpd2_codes=[division], category_division=division,
        customer_inn=customer_inn, start_price=request.start_price,
        top_k=request.top_k, candidates=list(pool.values()),
    ))
    if supplier_inn:
        for result in ranked["recommendations"]:
            result["rank_score"] = None  # Один точный ИНН не с кем ранжировать.
            result["reasons"].insert(0, "точное совпадение ИНН поставщика")
    return {"query": request.query, "category_division": division,
            "category_inferred": not bool(explicit_division), "mode": mode,
            "parsed_query": parsed_query, **ranked}
