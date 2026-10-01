"""Small, dependency-free Russian text normalization shared by training and API."""

from functools import lru_cache
import re
from math import sqrt


TOKEN_RE = re.compile(r"[0-9a-zа-яё]{3,}", re.IGNORECASE)
ENDINGS = (
    "иями", "ями", "ами", "ового", "евого", "енных", "енной", "енный",
    "ого", "его", "ому", "ему", "ыми", "ими", "иях", "иях",
    "ая", "яя", "ое", "ее", "ые", "ие", "ых", "их", "ый", "ий",
    "ия", "ию", "ям", "ам", "ах", "ях", "ов", "ев", "ей",
    "а", "я", "ы", "и", "е", "у", "ю", "о",
)
GENERIC_WORDS = """
и для при под над или как что это эти его ее она они
поставка поставку поставки поставок оказание оказанию оказания
услуга услуги услуг работу работы работ выполнение выполнению выполнения
нужды нужд государственного государственных государственный
закупка закупки закупку учреждение учреждений учреждения
санкт петербург петербурга город города
""".split()


def stem(word: str) -> str:
    word = word.lower().replace("ё", "е")
    for ending in ENDINGS:
        if word.endswith(ending) and len(word) - len(ending) >= 4:
            return word[:-len(ending)]
    return word


GENERIC_STEMS = frozenset(stem(word) for word in GENERIC_WORDS)


@lru_cache(maxsize=200_000)
def tokens(text: str) -> frozenset[str]:
    return frozenset(
        normalized for word in TOKEN_RE.findall(text or "")
        if (normalized := stem(word)) not in GENERIC_STEMS
    )


def overlap(left: str, right: str) -> float:
    a, b = tokens(left), tokens(right)
    if not a or not b:
        return 0.0
    return len(a & b) / sqrt(len(a) * len(b))
