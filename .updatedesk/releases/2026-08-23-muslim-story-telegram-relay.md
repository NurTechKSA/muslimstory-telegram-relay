---
project: muslim-story
public: false
backfilled: true
type: internal
audience: team
title: Telegram-ретранслятор для Muslim Story
summary: Появился промежуточный сервис, который принимает сообщения из Telegram и пересылает ответы бота обратно, с повторными попытками при сбоях.
user_impact:
  - Сообщения бота Muslim Story доходят стабильнее.
  - При временных сбоях отправка повторяется автоматически.
screenshots: []
checks: []
deploy_url:
commits: 13bb7a3..ac699cf
---

Notes for editor:
- What changed: воркер принимает входящие вебхуки Telegram и проксирует исходящие запросы к Bot API; настроены повторы исходящих запросов.
- Where to verify: бот Muslim Story в Telegram.
- Risks: восстановлено по git log задним числом.
