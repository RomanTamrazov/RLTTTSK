#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_PID=""
FRONTEND_PID=""

stop_demo() {
  [[ -z "$FRONTEND_PID" ]] || kill "$FRONTEND_PID" 2>/dev/null || true
  [[ -z "$WORKER_PID" ]] || kill "$WORKER_PID" 2>/dev/null || true
}
trap stop_demo EXIT INT TERM

if [[ ! -f "$ROOT_DIR/cloudflare/generated/model.json" || ! -f "$ROOT_DIR/cloudflare/generated/data.sql" || ! -f "$ROOT_DIR/cloudflare/generated/enrichment.sql" ]]; then
  echo "Не найдены локальные файлы модели, каталога или обогащения. Сначала создай их командами:"
  echo "  python3 backend/export_cloudflare.py"
  echo "  python3 backend/export_enrichment.py"
  exit 1
fi

if [[ ! -x "$ROOT_DIR/cloudflare/node_modules/.bin/wrangler" || ! -d "$ROOT_DIR/frontend/node_modules" ]]; then
  echo "Зависимости не установлены. Выполни один раз:"
  echo "  (cd cloudflare && npm ci)"
  echo "  (cd frontend && npm ci)"
  exit 1
fi

IMPORT_MARKER="$ROOT_DIR/cloudflare/.wrangler/demo-data-imported"
if [[ ! -f "$IMPORT_MARKER" ]]; then
  echo "Первый запуск: импортирую каталог в локальную SQLite D1. Это может занять несколько минут."
  cd "$ROOT_DIR/cloudflare"
  WRANGLER_WRITE_LOGS=false npx wrangler d1 execute rltttsk-suppliers --local --file generated/data.sql --yes >/dev/null
  WRANGLER_WRITE_LOGS=false npx wrangler d1 execute rltttsk-suppliers --local --file generated/enrichment.sql --yes >/dev/null
  mkdir -p .wrangler
  touch "$IMPORT_MARKER"
fi

echo "Запускаю локальный API (SQLite D1 + CatBoost) и сайт."
echo "Открой http://127.0.0.1:5173 — остановить можно Ctrl+C."
(
  cd "$ROOT_DIR/cloudflare"
  WRANGLER_WRITE_LOGS=false npx wrangler dev --local --ip 127.0.0.1 --port 8787
) &
WORKER_PID=$!

(
  cd "$ROOT_DIR/frontend"
  npm run dev -- --host 127.0.0.1
) &
FRONTEND_PID=$!

wait "$WORKER_PID" "$FRONTEND_PID"
