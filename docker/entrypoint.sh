#!/bin/sh
# Root only to start sshd (127.0.0.1 only, user localadm); the app itself drops to uid 1000.
set -eu

ssh_dir=/data/ssh
# The app (uid 1000) owns its volumes; localadm must not read the database, backups, opencode's data or node notes.
chown 1000:1000 /data /infra
chmod 700 /data /infra
mkdir -p "$ssh_dir/host"
chmod 700 "$ssh_dir/host"
# Keys live in the volume so a rebuilt image keeps the pinned host key and the stored credential.
[ -f "$ssh_dir/host/ssh_host_ed25519_key" ] || ssh-keygen -q -t ed25519 -N '' -C sysadm-localhost -f "$ssh_dir/host/ssh_host_ed25519_key"
[ -f "$ssh_dir/localhost_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C sysadm-localhost -f "$ssh_dir/localhost_ed25519"
chown 1000:1000 "$ssh_dir" "$ssh_dir/localhost_ed25519" "$ssh_dir/localhost_ed25519.pub"
install -d -o localadm -g localadm -m 700 /home/localadm/.ssh
install -o localadm -g localadm -m 600 "$ssh_dir/localhost_ed25519.pub" /home/localadm/.ssh/authorized_keys

mkdir -p /run/sshd
# Empty env: the master key from .env must not reach sshd or the sessions it spawns.
env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/sbin/sshd

exec setpriv --reuid=1000 --regid=1000 --init-groups env HOME=/home/bun "$@"
