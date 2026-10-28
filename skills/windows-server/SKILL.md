---
name: windows-server
description: Windows Server по OpenSSH — оболочка PowerShell, разведка системы, службы, журналы событий, обновления, диски, роли. Используется на Windows-узлах.
---

# Windows Server (OpenSSH, PowerShell)

Оболочка на узле — PowerShell. Все команды пиши как PowerShell, не как cmd.

## Разведка (только чтение)
- Система: `Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsHardwareAbstractionLayer, CsName`
- Службы с ошибкой: `Get-Service | Where-Object Status -ne 'Running' | Where-Object StartType -eq 'Automatic'`
- Журнал ошибок: `Get-WinEvent -LogName System -MaxEvents 50 | Where-Object LevelDisplayName -eq 'Error'`
- Журнал приложений: `Get-WinEvent -LogName Application -MaxEvents 50`
- Обновления: `Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 10`
- Диски: `Get-Volume`
- Роли и компоненты: `Get-WindowsFeature | Where-Object Installed`

## Обновления Windows
- Список доступных обновлений требует модуль PSWindowsUpdate: `Get-WindowsUpdate`. Если модуля нет, так и скажи, не ставь его сам.
- Установка обновлений и перезагрузка — опасные, подтверждение обязательно.

## Роли IIS и AD
- Только чтение без явной просьбы: `Get-Website`, `Get-WebBinding`, `Get-ADUser`, `Get-ADDomainController`.
- Изменение конфигурации IIS или AD — только по явной просьбе, с подтверждением.

## Подтверждения
- `-Confirm:$false` используй только если пользователь явно разрешил.
- `Stop-Computer`, `Restart-Computer`, `Format-Volume`, `Remove-Item -Recurse` — опасные.
- Остановка службы (`Stop-Service`, `Set-Service -StartupType Disabled`) — опасная.

## Ограничения
- Не предлагай RDP и GUI-шаги. Всё через SSH и PowerShell.
- Не используй интерактивные команды: `Read-Host`, `Out-GridView`, `notepad`.
- Вывод длинных списков ограничивай через `Select-Object -First N`.
