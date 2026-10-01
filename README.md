# Рекомендатель поставщиков

CatBoost ранжирует компании для закупки по истории побед, категории, заказчику и похожести работ. Веб-интерфейс команды размещается в `frontend/`, Python API — на отдельном сервере.

## Структура

| Файл или папка | Назначение |
| --- | --- |
| `frontend/` | Сюда сокомандник загружает сайт; сейчас здесь временная страница |
| `.github/workflows/pages.yml` | Публикация интерфейса на GitHub Pages |
| `prepare_catboost_data.py` | pandas: очистка CSV, история на дату закупки и профили |
| `train_catboost.py` | Обучение CatBoost и оценка ранжирования |
| `site_api.py` | `GET /health`, `POST /search`, `POST /recommend` |
| `model_schema.py` | Общий список признаков обучения и API |
| `query_parser.py` | Текст, ИНН и ОКПД2 из одной строки |
| `artifacts/` | Локальная модель и профили; в Git включены только отчёт и важности |

Схема данных, признаки и метрики подробно описаны в [объяснении модели](ОБЪЯСНЕНИЕ_МОДЕЛИ.md). Команды и контракт API — в [инструкции](README_рекомендатель.md).

## Запуск модели локально

Нужен Python 3.11+. Исходные три CSV из выгрузки хранятся локально и исключены из Git.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python prepare_catboost_data.py --data-dir /путь/к/исходным/csv
python train_catboost.py
uvicorn site_api:app --host 127.0.0.1 --port 8000
```

Интерактивный контракт API: `http://127.0.0.1:8000/docs`. Можно передать одну строку:

```json
{"query":"ремонт автоэвакуатора ОКПД2 45.20.2 ИНН заказчика 7842019044","top_k":10}
```

Для отдельного сервера API есть Dockerfile:

```bash
docker build -t supplier-recommender .
docker run --rm -p 8000:8000 -v "$PWD/artifacts:/app/artifacts:ro" supplier-recommender
```

Модель обучается по меткам ЭМ; АИС ГЗ дополняет каталог поиска. Исторические результаты рассчитываются строго из более ранних закупок. Метрики в `artifacts/training_report.json` относятся к ранжированию записанных участников, а не ко всему рынку.

## Репозиторий и GitHub Pages

Репозиторий команды: [RomanTamrazov/RLTTTSK](https://github.com/RomanTamrazov/RLTTTSK). Для новой локальной копии:

```bash
git clone git@github.com:RomanTamrazov/RLTTTSK.git
cd RLTTTSK
```

В репозитории уже выбран **Settings → Pages → Source → GitHub Actions**. Адрес интерфейса: https://romantamrazov.github.io/RLTTTSK/. Workflow публикует только `frontend/` или результат её сборки. Это соответствует [официальному способу публикации Pages через Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

Сокомандник заменяет временную страницу своим сайтом по [инструкции в frontend](frontend/README.md). После его коммита подключим интерфейс к отдельному HTTPS API: адрес сервера, CORS и карточки рекомендаций. GitHub Pages исполняет статический интерфейс; Python-модель запускается на сервере API.

Исходные данные, подготовленная выборка и профили не попадут в коммит благодаря `.gitignore`. После клонирования серверу API понадобится локальная папка `artifacts/` одной версии: получить её от команды или заново подготовить данные и обучить модель.
