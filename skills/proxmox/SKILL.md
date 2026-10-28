---
name: proxmox
description: Proxmox VE — хосты-гипервизоры: версия, ВМ и контейнеры, хранилища, кластер, ZFS, снапшоты и бэкапы. Читай вместе с linux-common.
---

# Proxmox VE

Сначала прочитай скил `linux-common`. Proxmox — это Debian с собственными инструментами.

## Разведка (только чтение)
- Версия: `pveversion -v`
- ВМ: `qm list`
- Контейнеры: `pct list`
- Конфиг ВМ: `qm config <id>`
- Конфиг контейнера: `pct config <id>`
- Хранилища: `pvesm status`
- Кластер: `pvecm status` (на одиночном хосте вернёт ошибку — это нормально)
- ZFS: `zpool status`, `zfs list`
- Задачи: `pvesh get /nodes/$(hostname)/tasks --limit 20`

## Снапшоты и бэкапы
- Перед любым изменением ВМ делай снапшот: `qm snapshot <id> pre-change-$(date +%Y%m%d%H%M)`
- Список: `qm listsnapshot <id>`
- Бэкап: `vzdump <id> --mode snapshot --storage <хранилище>` — долгая операция, запускай в фоне и читай лог.
- Откат снапшота — только с подтверждением пользователя.

## Опасные операции (подтверждение обязательно)
- `qm stop`, `qm shutdown`, `qm reset`
- `qm destroy`, `pct destroy`
- `pct stop`
- `zfs destroy`, `zpool destroy`
- Удаление хранилища и изменение `storage.cfg`
- Перенос ВМ между узлами кластера

## Правила
- Не выключай и не удаляй ВМ по имени, сверь ID из `qm list` и имя из `qm config <id>`.
- Не трогай `/etc/pve` напрямую — это кластерная файловая система. Правь через `qm set`, `pct set`, `pvesh`.
- Миграция и HA — только по явной просьбе.
