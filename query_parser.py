"""Разбор одной поисковой строки на предмет закупки, ОКПД2 и ИНН.

ИНН без роли означает поставщика. Для персонализации по заказчику пользователь
пишет «ИНН заказчика ...»; так строка не получает двусмысленное толкование.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


INN_NUMBER = r"(?<!\d)(?:\d{12}|\d{10})(?!\d)"
ROLE_INN_RE = re.compile(
    rf"\b(?P<role>инн\s+заказчика|заказчик(?:а)?(?:\s+инн)?|"
    rf"инн\s+поставщика|поставщик(?:а)?(?:\s+инн)?|инн)\s*[:№]?\s*"
    rf"(?P<inn>{INN_NUMBER})",
    re.IGNORECASE,
)
BARE_INN_RE = re.compile(INN_NUMBER)
LABELED_OKPD2_RE = re.compile(
    r"\bокпд\s*[- ]?\s*2\s*[:№]?\s*(?P<code>\d{2}(?:\.\d{1,3}){0,4})(?![\d.])",
    re.IGNORECASE,
)
BARE_OKPD2_RE = re.compile(r"(?<![\w.])(?P<code>\d{2}(?:\.\d{1,3}){1,4})(?![\w.])")
LEFTOVER_LABEL_RE = re.compile(r"\b(?:инн|окпд\s*[- ]?\s*2|заказчик(?:а)?|поставщик(?:а)?)\b", re.IGNORECASE)


@dataclass(frozen=True)
class ParsedQuery:
    purchase_text: str = ""
    okpd2_code: str = ""
    customer_inn: str = ""
    supplier_inn: str = ""


def _single(values: list[str], kind: str) -> str:
    unique = list(dict.fromkeys(values))
    if len(unique) > 1:
        raise ValueError(f"В одной строке найдено несколько разных {kind}; уточните запрос.")
    return unique[0] if unique else ""


def parse_search_query(raw: str) -> ParsedQuery:
    """Распознаёт, например, «ремонт 45.20.2 ИНН заказчика 7842019044»."""
    buyer_inns: list[str] = []
    supplier_inns: list[str] = []

    def take_labeled_inn(match: re.Match[str]) -> str:
        target = buyer_inns if "заказчик" in match.group("role").lower() else supplier_inns
        target.append(match.group("inn"))
        return " "

    rest = ROLE_INN_RE.sub(take_labeled_inn, raw)
    supplier_inns.extend(BARE_INN_RE.findall(rest))
    rest = BARE_INN_RE.sub(" ", rest)

    codes: list[str] = []

    def take_code(match: re.Match[str]) -> str:
        codes.append(match.group("code"))
        return " "

    rest = LABELED_OKPD2_RE.sub(take_code, rest)
    rest = BARE_OKPD2_RE.sub(take_code, rest)
    if re.fullmatch(r"\s*\d{2}\s*", rest):
        codes.append(rest.strip())
        rest = ""

    rest = LEFTOVER_LABEL_RE.sub(" ", rest)
    purchase_text = " ".join(re.sub(r"[,;:№]+", " ", rest).split())
    return ParsedQuery(
        purchase_text=purchase_text,
        okpd2_code=_single(codes, "кодов ОКПД2"),
        customer_inn=_single(buyer_inns, "ИНН заказчика"),
        supplier_inn=_single(supplier_inns, "ИНН поставщика"),
    )
