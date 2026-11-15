# Сборка phpcode из чистого клона

## Закреплённая база

`upstream.json` задаёт официальный тег Code OSS `1.146.0`, коммит `69047191fc427f2f92828279aae1d90d8eeda7ab`, Node `24.22.1`, pnpm `12.16.0` и multiarch Docker-образ Node по digest. Bootstrap загружает именно этот коммит и применяет все компоненты, продуктовые настройки и тесты. Все установки зависимостей выполняются с `--frozen-lockfile`. Корневой lockfile, отдельный lockfile драйверов БД и upstream lockfiles должны храниться вместе с исходниками.

Это воспроизводимость исходников и процесса сборки; двоичное совпадение архивов не гарантируется: упаковщики добавляют время сборки, а системные компиляторы зависят от ОС. Для выпуска одинакового релиза используйте один коммит phpcode и одни версии среды. Сведения о коммитах, версии Node и SHA-256 готовых пакетов записываются в `.build/artifacts/build-<platform>.json`.

## Общие требования

Git, Node **24.22.1** из официального дистрибутива, Corepack, Python 3 с setuptools, C++ компилятор и свободное место для полного Code OSS/Electron и нативных зависимостей. Планируйте не менее 30 ГБ свободного места и 16 ГБ RAM. Путь клона желательно без пробелов: некоторые upstream native build tools их не поддерживают. Нужен доступ к GitHub, npm registry, Node/Electron downloads и Docker Hub.

Версия Node указана в `.nvmrc`. Можно использовать nvm/fnm или установить её напрямую. В Node 24 Corepack входит в официальный дистрибутив; если ваша установка его исключает, установите Corepack отдельно: `npm install --global corepack`. Установка глобального pnpm не требуется. `node scripts/phpcode.cjs doctor` проверяет Node, pnpm и базовый коммит; наличие всех системных библиотек проверяется уже нативной сборкой.

Docker Desktop на Windows/macOS или Docker Engine на Linux нужен для сборки серверов Dev Container и интеграционных тестов БД. На Windows переключите Docker на Linux containers. В Docker Desktop доступна эмуляция ARM64/x64. На обычном Linux для второй архитектуры потребуется binfmt/QEMU. CI использует `docker/setup-qemu-action`. Не копируйте `node_modules` между ОС, архитектурами и деревьями исходников.

## Windows x64

Используйте Windows 10/11 и PowerShell, Git for Windows, Node 24.22.1, Python 3, Visual Studio Build Tools 2022 или 2026. В Visual Studio Installer добавьте Desktop development with C++, Windows 11 SDK 26100, Spectre-mitigated C++ runtime, ATL и MFC. Идентификаторы компонентов:

```text
Microsoft.VisualStudio.Workload.VCTools
Microsoft.VisualStudio.Component.Windows11SDK.26100
Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre
Microsoft.VisualStudio.Component.VC.ATL.Spectre
Microsoft.VisualStudio.Component.VC.ATLMFC.Spectre
```

Устанавливайте setuptools в окружение используемого Python. Убедитесь, что `python`, `git`, `node` доступны из нового терминала. Рекомендуемый путь клона: `C:\src\phpcode`. Поддержка ARM64 предусмотрена upstream и выбором target, но отдельного прогона Windows ARM64 в CI пока нет. Installer создаётся встроенным upstream пакетом Inno Setup; дополнительная установка Inno Setup не требуется.

## Linux

Базовая платформа — Ubuntu 24.04 x64, glibc. Для неё:

```sh
sudo apt-get update
sudo apt-get install -y build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev python-is-python3 python3-setuptools fakeroot rpm
```

Docker Engine должен быть доступен текущему пользователю. Для GUI нужен обычный графический сеанс. Electron также требует системные runtime-библиотеки; `.deb` объявляет рассчитанные зависимости. Linux ARM64 выбирается автоматически на ARM64-хосте, но отдельной desktop job для него пока нет. Серверы Dev Container собираются в Debian 12 и требуют glibc 2.36 или новее; musl/Alpine и Windows-контейнеры не поддерживаются.

## macOS

Установите Xcode Command Line Tools (`xcode-select --install`), Node 24.22.1, Python 3 с setuptools, Git и Docker Desktop. Архитектура выбирается по Node (`arm64` или `x64`): используйте нативную версию Node. Для распространения подписанного приложения нужны свои Developer ID и notarization; текущие команды создают неподписанный `.dmg`.

## Подготовка и сборка

Команды выполняются из корня клона, одинаково во всех трёх ОС:

```sh
node scripts/phpcode.cjs bootstrap
corepack pnpm test
node scripts/phpcode.cjs servers
node scripts/phpcode.cjs build
node scripts/phpcode.cjs package
node scripts/phpcode.cjs start
```

Bootstrap создаёт `.build/code-oss`, устанавливает зависимости продукта, драйверов и upstream, применяет overlays. Загрузка исходников сначала выполняется во временный каталог, чтобы прерывание не оставило полузагруженное рабочее дерево. Если существующий checkout имеет другой HEAD, команда останавливается и оставляет файлы нетронутыми. Корневой Corepack cache хранится в `.build/corepack`.

`servers` компилирует сервер и встроенные расширения, затем отдельно собирает нативные Linux-зависимости для x64 и ARM64. Одноразовые контейнеры с уникальными именами удаляются после работы. Node runtime и его лицензия берутся из того же закреплённого образа. Архивы и manifest SHA-256 лежат в `.build/server-assets` и встраиваются в приложение; пользовательский phpcode устанавливается без необходимости отдельно скачивать эти серверы. Для сборки только одного архива укажите `servers linux-x64` или `servers linux-arm64`; для упаковки desktop нужны оба.

`build` проверяет коммит upstream, наличие и SHA-256 обоих серверов, повторно применяет компоненты и выполняет полную нативную сборку. Выходная папка — `.build/VSCode-<os>-<arch>`. Сборка Windows выполняется на Windows, Linux — на Linux, macOS — на macOS. Кросс-компиляция desktop этими командами не предоставляется.

`package` упаковывает уже собранное приложение. Windows: пользовательский installer и ZIP; Linux: DEB и tar.gz; macOS: DMG. Перед новой упаковкой после изменения исходников повторите `build`. SHA-256 и сведения о сборке находятся рядом с пакетами.

Можно перенести `.build/server-assets` из успешной CI job того же коммита phpcode вместо повторной локальной сборки серверов. Исходный коммит Code OSS, SHA-256 архивов и digest исходников наших компонентов проверяются автоматически; manifest от другой версии компонентов отклоняется. Секреты, ключ BotHub, пользовательские БД и `.env` для сборки не нужны.

## Разработка и тесты

```sh
node scripts/phpcode.cjs apply
node scripts/phpcode.cjs exec pnpm run build-fast --client-only
corepack pnpm test
corepack pnpm test:database
```

Для targeted unit tests ядра сначала подготовьте JS через `build-fast`, затем из `.build/code-oss` запустите `scripts/test.sh` (Linux/macOS) или `scripts\test.bat` (Windows), например с `--run src/vs/workbench/contrib/phpcode/test/common/runtime.test.ts --grep phpcode`. Тесты агента и provider находятся в `agent/`, `agentProvider/`; apply переносит их в соответствующие upstream suites. Три теста продуктового отключения прежнего провайдера сохранены в `patches/branding-tests.patch` и `overlays/`; патч проверяется перед применением и допускает повторный запуск.

`verify-base.cjs` проверяет базовый редактор через Extension API, `verify-agent.cjs`, `verify-database.cjs`, `verify-devcontainers.cjs` и `verify-visible-branding.cjs` — GUI через Playwright/Electron. Передавайте `PHPCODE_PACKAGED_EXECUTABLE` с абсолютным путём собранного приложения. Эти GUI-сценарии исторически проверены на macOS и используют сочетания Meta; их успешный прогон на Windows/Linux пока не заявлен. В CI запускаются переносимые Node tests и реальная интеграция с БД, затем сборка пакетов.

Для выполнения произвольной upstream команды: `node scripts/phpcode.cjs exec pnpm run gulp --tasks-simple`. `run.sh` и `run.cmd` являются короткими обёртками над `exec`. Старый checkout можно временно подключить переменной `PHPCODE_OSS_PATH` с абсолютным путём; HEAD должен совпадать с `upstream.json`. Это режим миграции, для проверки воспроизводимости используйте стандартный `.build/code-oss`. Для нестандартной установки Corepack допустима `PHPCODE_PNPM_CLI`, указывающая на JS entry `pnpm/bin/pnpm.mjs` версии 12.16.0.

## Git и обновление upstream

Коммитьте исходники, overlays, патчи, manifests, lockfiles, документацию и workflow. Сборочные деревья, node_modules, архивы, установщики, `.env` и ключи исключены `.gitignore`. После `git clone` не требуется копировать файлы с компьютера автора.

Меняя ядро, переносите правку в идемпотентный apply-script либо патч/overlay и проверяйте её на чистом pinned checkout. Не сохраняйте изменения только в `.build`. Для обновления Code OSS измените `upstream.json`, проверьте соответствие Node/pnpm, все apply-script anchors и патчи; используйте новое чистое дерево сборки и прогоните CI. Старое дерево скрипты автоматически не сбрасывают.

Workflow `Build phpcode` запускается на push/PR и вручную: быстрые тесты на трёх ОС, Linux job сборки двух серверов с Docker/QEMU, затем нативные Windows/Linux/macOS jobs. Готовые пакеты скачиваются из artifacts соответствующего run. Workflow не публикует релизы и не подписывает установщики. Настройка workflow сама по себе не является подтверждением успешной сборки на всех платформах: проверяйте фактический статус run.

Основные требования среды сверены с [официальной инструкцией Code OSS](https://github.com/microsoft/vscode/wiki/How-to-Contribute); конкретные версии определяет закреплённое дерево исходников. Передача результатов между CI jobs использует [GitHub Actions artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data).
