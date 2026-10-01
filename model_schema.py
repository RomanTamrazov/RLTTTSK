"""Shared feature contract for training and website inference."""

SCHEMA_VERSION = 5
# The 2024 electronic-store training prices have their 99.9th percentile here.
# Some repair lots contain sums of unit prices that are not comparable to a lot budget.
PRICE_CAP_EM = 600_000.0

FEATURES = [
    "history_participations", "history_wins", "history_win_rate",
    "days_since_supplier_activity",
    "category_participations", "category_wins", "category_win_rate",
    "category_code_match", "days_since_category_activity",
    "buyer_participations", "buyer_wins", "buyer_win_rate", "buyer_category_wins",
    "start_price_log", "text_similarity", "category_count",
    "category_division",
]

CATEGORICAL = ["category_division"]
