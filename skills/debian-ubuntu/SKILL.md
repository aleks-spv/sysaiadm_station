---
name: debian-ubuntu
description: Debian и Ubuntu — apt, обновления безопасности, сеть (netplan или /etc/network/interfaces), snap, needrestart. Читай вместе с linux-common.
---

# Debian / Ubuntu

Сначала прочитай скил `linux-common`: там общие правила (sudo -n, бэкапы, проверки).

## apt
- Список обновлений (только чтение): `apt list --upgradable 2>/dev/null`
- Обновить индекс: `sudo -n DEBIAN_FRONTEND=noninteractive apt-get update`
- Установка: `sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y <пакет>` — только после явного разрешения.
- Удаление и `dist-upgrade`: опасные, подтверждение обязательно.
- Состояние пакетов после сбоя: `sudo -n dpkg --audit`

## Автоматические обновления
- Проверить: `systemctl status unattended-upgrades --no-pager`
- Конфиг: `/etc/apt/apt.conf.d/50unattended-upgrades` (бэкап перед правкой).
- Пробный прогон: `sudo -n unattended-upgrade --dry-run --debug`

## Сеть
- Ubuntu с netplan: конфиг в `/etc/netplan/*.yaml`. Перед `netplan apply` обязательно `sudo -n netplan generate` и проверка, что есть путь назад (консоль или второй адрес). Применение сетевых настроек по SSH без страховки опасно.
- Debian или старый Ubuntu: `/etc/network/interfaces`. Проверка: `sudo -n ifquery --list` и `ip -br addr`.
- Не меняй сеть на хосте, если SSH идёт через этот интерфейс, без явного подтверждения.

## snap
- `snap list`, `snap changes`, `snap refresh --list`
- Обновление snap-пакета — только после подтверждения.

## Перезапуск после обновлений
- `needrestart -b` (неинтерактивный отчёт; ставится пакетом `needrestart`).
- Какие сервисы перезапустить — решает пользователь, сам не перезапускай.

## Типичные проверки
- Место под `/var/cache/apt`: `du -sh /var/cache/apt/archives`
- Сломанные зависимости: `sudo -n apt-get -f install` — только с подтверждением.
- Время и NTP: `timedatectl --no-pager`
