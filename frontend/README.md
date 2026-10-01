# Сайт RLTTTSK

Интерфейс команды подключён к CatBoost API в Cloudflare Worker. Он отправляет одну поисковую строку на `/search` и показывает ранжированных поставщиков вместе с историей и причинами рекомендации.

```bash
npm ci
npm run dev
npm run build
```

Адрес API задаётся в `public/config.json`. Для локального Worker можно указать `/api`: Vite перенаправляет запросы на `http://localhost:8787`. Для опубликованного сайта укажите полный HTTPS адрес Worker; CORS ограничен адресом GitHub Pages и локальным Vite. Публикация Pages происходит автоматически после коммита в `main`.
