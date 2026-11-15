# phpcode

Самостоятельная IDE на базе Code OSS: собственный агент BotHub, клиент MySQL/MariaDB и PostgreSQL, Dev Containers, тема Dracula и дерево проекта с иконками. Приложение собирается целиком вместе со встроенными компонентами.

Готовые установщики и переносимые архивы распространяются через [GitHub Releases](https://github.com/maxharperua/phpcode/releases). Там же находятся SHA-256 и сведения о сборках. В истории Git хранятся исходники и сборочные инструкции; большие исполняемые файлы прикрепляются к релизам.

В этом репозитории хранятся все наши исходники, изменения ядра, тесты, спецификация и сборочные скрипты. База редактора загружается автоматически из официального репозитория Microsoft по точному коммиту из `upstream.json`. Для клонирования не нужны соседний `phpcode-oss`, локальные инструменты автора или архивы прежних сборок. История Git сохранена.

## Быстрый старт

Установите Git, **Node 24.22.1 с Corepack**, Python и C++ инструменты для своей ОС по [инструкции сборки](docs/BUILDING.md). Для серверов Dev Container нужен Docker с Linux-контейнерами.

```sh
git clone https://github.com/maxharperua/phpcode.git
cd phpcode
node scripts/phpcode.cjs bootstrap
node scripts/phpcode.cjs servers
node scripts/phpcode.cjs build
node scripts/phpcode.cjs start
```

Эти команды одинаковы в PowerShell, Linux и macOS. Нативное приложение собирается для текущей ОС и архитектуры. Установщик и контрольные суммы создаются командой:

```sh
node scripts/phpcode.cjs package
```

Результаты находятся в `.build/artifacts/`: Windows — пользовательский `.exe` и переносимый `.zip`, Linux — `.deb` и `.tar.gz`, macOS — `.dmg`. Пакеты без цифровой подписи; сборка macOS без notarization.

## Структура

- `agent/` — интерфейс чата, сессии, цикл инструментов, индекс проекта и суммаризация.
- `agentProvider/` — транспорт BotHub, IPC и хранение ключа.
- `database/`, `database-runtime/` — клиент БД и закреплённые драйверы.
- `devcontainers/` — собственный remote resolver и управление контейнерами.
- `apply-*.cjs`, `patches/`, `overlays/` — воспроизводимые изменения Code OSS и тесты интеграции с ядром.
- `scripts/`, `upstream.json`, `pnpm-lock.yaml` — подготовка, сборка, упаковка и версии инструментов.
- `.github/workflows/build.yml` — тесты и нативная сборка на Windows, Linux и macOS; серверы Linux x64/ARM64 собираются отдельно.
- `.build/` — скачанные исходники, изолированные зависимости серверов и результаты сборки; исключён из Git.

После изменения наших исходников повторите `node scripts/phpcode.cjs apply`, затем нужную сборку. Файлы в `.build/code-oss` являются рабочим деревом сборки: сохраняйте изменения ядра в `apply-*.cjs`, патчах или overlays, иначе их не будет в новом клоне. Скрипты не сбрасывают существующее дерево Git и проверяют его базовый коммит.

## Проверка

```sh
corepack pnpm test
corepack pnpm test:database
```

Первая команда проверяет сборочную конфигурацию, dotenv и Dev Container configuration. Вторая после bootstrap поднимает собственные одноразовые MariaDB/PostgreSQL в Docker, проверяет редактор данных, SQL, поиск и сортировку, затем удаляет только свои контейнеры. Тесты агента, ядра и интерфейса описаны в [BUILDING.md](docs/BUILDING.md).

[Требования](PRODUCT_REQUIREMENTS.md), [агент](AGENT.md), [базы данных](DATABASE.md), [Dev Containers](DEVCONTAINERS.md), [история проверок](docs/VERIFICATION_HISTORY.md). Спецификация содержит также запланированные возможности; наличие пункта в ней не означает, что он уже реализован. Например, SQLite, SSH и расширенная PHP-интеграция ещё не завершены.

## Лицензия

Code OSS распространяется по [MIT](LICENSE.txt). Его лицензии и Third Party Notices сохраняются в сборке; собственные компоненты содержат лицензии включённых зависимостей. Проприетарный код Cursor и Microsoft Remote Containers не используется. Каталог расширений — Open VSX; наличие и работоспособность каждого стороннего расширения проверяются отдельно.
