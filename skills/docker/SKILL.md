---
name: docker
description: Docker и Docker Compose на удалённом сервере через remote_exec: состояние контейнеров, логи, рестарт, обновление образов, место на диске, compose-стеки. Use when the task mentions docker, контейнер, compose, образ, volume.
---

# Docker и Docker Compose

Общие правила Linux (неинтерактивный режим, `sudo -n`, бэкап перед правкой) действуют и здесь: см. `linux-common`.

Каждая команда выполняется одним вызовом `remote_exec`, без TTY, и должна завершиться сама. Команды, которые ждут ввода или работают бесконечно, зависнут до таймаута.

## Запрещено в любой команде
- Флаги `-i` и `-t` (например `docker exec -it`, `docker run -it`).
- `docker attach`.
- `docker logs -f` и `--follow` (используй `--tail` и `--since`).
- `docker stats` без `--no-stream`.
- `docker compose up` без `-d`.
- Пейджеры: `less`, `more`.

## 1. Первые шаги

Проверь, что Docker есть и доступен текущему пользователю.

```bash
command -v docker && docker --version
docker info --format '{{.ServerVersion}} | containers={{.Containers}} running={{.ContainersRunning}} stopped={{.ContainersStopped}}'
```

Если `docker info` пишет `permission denied` на сокет, повтори с `sudo -n`:

```bash
sudo -n docker info --format '{{.ServerVersion}}'
```

Если `sudo -n` просит пароль, остановись и сообщи админу. Не передавай пароль через `sudo -S`.

Определи версию Compose. Предпочитай v2 (`docker compose`), v1 (`docker-compose`) используй только если v2 отсутствует:

```bash
docker compose version 2>/dev/null || docker-compose version 2>/dev/null || echo "compose не найден"
```

Общая картина:

```bash
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
```

Только читай. Ничего не перезапускай, пока не собрал картину.

## 2. Диагностика контейнера

Состояние, счётчик рестартов, код выхода, OOM и healthcheck. Переменные окружения здесь не выводятся:

```bash
docker inspect --format 'name={{.Name}} state={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} started={{.State.StartedAt}}' NAME
```

Что означают значения:
- `exit=137` и `oom=true`: контейнер убит OOM-killer, не хватило памяти. Смотри лимиты `docker inspect --format '{{.HostConfig.Memory}}' NAME` (0 значит без лимита).
- `exit=1`, `exit=2` и другие: приложение завершилось с ошибкой, смотри логи.
- `restarts` растёт: цикл падений, смотри логи последнего запуска.
- `health=unhealthy`: смотри последние результаты проверки:

```bash
docker inspect --format '{{range .State.Health.Log}}{{.End}} exit={{.ExitCode}} {{.Output}}{{end}}' NAME | tail -n 20
```

Логи с временными метками, без потоковой передачи:

```bash
docker logs --tail 200 --timestamps NAME
docker logs --since 30m --timestamps NAME
```

Ошибки в логах (ограничь вывод):

```bash
docker logs --since 1h --timestamps NAME 2>&1 | grep -iE 'error|fatal|panic|exception' | tail -n 50
```

Потребление ресурсов, один снимок:

```bash
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}'
```

Внутри контейнера, без TTY. Указывай конкретные команды, не оболочку с выводом всего:

```bash
docker exec NAME sh -c 'ps aux | head -n 20; df -h | head -n 10'
```

Если в образе нет `sh`, используй `docker exec NAME <бинарь> <аргументы>` напрямую.

## 3. Compose-стеки

Найди каталог стека по меткам контейнера:

```bash
docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}} | {{index .Config.Labels "com.docker.compose.project.working_dir"}} | {{index .Config.Labels "com.docker.compose.project.config_files"}}' NAME
```

Список всех compose-проектов на хосте:

```bash
docker ps -a --filter label=com.docker.compose.project --format '{{.Label "com.docker.compose.project"}}' | sort -u
```

Работай с конкретным файлом `-f`, не полагаясь на текущий каталог:

```bash
docker compose -f /opt/stack/compose.yaml ps -a
docker compose -f /opt/stack/compose.yaml logs --tail 200 --timestamps --no-color SVC
```

Проверка файла без вывода секретов. `docker compose config` печатает значения из `.env` подставленными, поэтому не используй его без фильтра:

```bash
docker compose -f /opt/stack/compose.yaml config --quiet && echo "синтаксис ок"
docker compose -f /opt/stack/compose.yaml config --services
docker compose -f /opt/stack/compose.yaml config --images
```

Порядок обновления:
1. Бэкап файла стека: `cp -a /opt/stack/compose.yaml /opt/stack/compose.yaml.bak.$(date +%F-%H%M)`.
2. Правь файл целиком через heredoc или `tee`, как в `linux-common`.
3. Проверь синтаксис: `docker compose -f ... config --quiet`.
4. Подтяни образы: `docker compose -f ... pull SVC`.
5. Подними только нужный сервис: `docker compose -f ... up -d SVC`. Compose пересоздаст только изменившиеся контейнеры.
6. Проверь состояние и логи (пункт 2).

Откат: верни бэкап и выполни `up -d` снова. Для возврата образа указывай тег в compose-файле, а не `latest`. У v1 (`docker-compose`) те же команды с `docker-compose -f ...`.

## 4. Место на диске

Сначала общая картина, без `-v`, он может быть очень большим:

```bash
df -h /var/lib/docker
docker system df
```

Потом детали, ограниченные по размеру:

```bash
docker system df -v | head -n 60
sudo -n du -sh /var/lib/docker/containers/*/*-json.log 2>/dev/null | sort -h | tail -n 10
```

Большие `*-json.log` означают отсутствие ротации. Чинится настройкой `log-opts` (`daemon.json`) или `logging` (compose), а не удалением логов на ходу.

Низкорисковые кандидаты на очистку:
- `docker builder prune -f`: кэш сборки. Пересоберётся при следующей сборке.
- `docker image prune -f`: только висячие образы (`<none>`), без тегов.

Для каждого кандидата сначала посмотри, что будет удалено и сколько места освободится:

```bash
docker image ls -f dangling=true --format 'table {{.ID}}\t{{.CreatedSince}}\t{{.Size}}'
docker builder du | tail -n 1
```

Удаление выполняется только после подтверждения админа.

Не удаляй без явного согласия:
- `docker container prune`: удаляет остановленные контейнеры вместе с их состоянием.
- `docker image prune -a`: удаляет все неиспользуемые образы, при откате придётся скачивать заново.
- `docker system prune` (любые флаги): комбинирует всё выше.
- `docker volume prune` и любые `--volumes`: volumes хранят данные баз и файлов. Удалённый volume не восстанавливается.

## 5. Сеть и порты

Опубликованные порты контейнера:

```bash
docker port NAME
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

Слушающие сокеты на хосте (используй `sudo -n`, иначе не будет имени процесса):

```bash
sudo -n ss -tlnp
```

Сети и их участники:

```bash
docker network ls --format 'table {{.Name}}\t{{.Driver}}\t{{.Scope}}'
docker network inspect NAME --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}'
```

Docker пишет правила в iptables/nft и может открыть порт мимо UFW. Изменение публикации портов — опасное действие, см. раздел 6.

## 6. Опасные действия (только с явного подтверждения админа)

Перед каждым пунктом покажи админу, что будет затронуто, и дождись ответа.

- Удаление volumes: `docker volume rm`, `docker volume prune`, `down -v`, `--volumes`.
- Любой `docker system prune`, `docker image prune -a`, `docker container prune`.
- `docker compose down` стека с базой или очередью. `down` удаляет контейнеры и сеть.
- Рестарт или пересоздание контейнеров баз данных (PostgreSQL, MySQL, MariaDB, Redis, MongoDB и т.п.). Сначала проверь, что есть свежий дамп.
- `docker rm -f`, `docker kill`, `docker stop` на контейнерах, которые не являются целью задачи.
- Правка compose-файла, `.env` или `daemon.json`. Всегда с бэкапом: `cp -a FILE FILE.bak.$(date +%F-%H%M)`.
- Перезапуск `docker` (сервис демона): останавливает все контейнеры на хосте. Используй `sudo -n systemctl restart docker --no-pager` только после подтверждения; статус потом `systemctl status docker --no-pager -l`.
- Смена публикации портов и правил фаервола.
- Смена тега образа на другой мажорный релиз: сначала прочитай changelog или документацию образа.

## 7. Секреты

- Не выводи `docker inspect` целиком (`.Config.Env` часто содержит пароли) и `docker compose config` без `--quiet`, `--services` или `--images` (он подставляет значения из `.env`). Для нужных полей используй точечный `--format`.
- Не копируй `.env` и compose-файлы в отчёт. Логи приложений перед пересылкой проверь и замаскируй пароли и токены.

## 8. Отчёт

- Какие контейнеры и стеки проверены, с выводом ключевых команд.
- Что изменено: команда, контейнер или файл, путь к бэкапу.
- Что не проверено: например, логи за пределами окна `--since`, или внутренние проверки приложения.
- Если команда требовала пароль (`sudo -n` упал), так и напиши и остановись.
