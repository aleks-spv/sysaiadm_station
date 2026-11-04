import { expect, test } from "bun:test";
import { factsMarkdown, osFromFacts, parseLinuxFacts, parseWindowsFacts } from "./facts";

const LINUX = `
### hostname
pve1.lan
### os
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
ID=debian
### kernel
6.8.12-4-pve
### uptime
86400.50 170000.00
### virt
none
### vendor
Dell Inc.
PowerEdge R640
### cpu
Architecture:                       x86_64
CPU(s):                             48
Model name:                         Intel(R) Xeon(R) Gold 6126 CPU @ 2.60GHz
Thread(s) per core:                 2
Core(s) per socket:                 12
Socket(s):                          2
### mem
MemTotal:       263840000 kB
MemFree:         1000000 kB
MemAvailable:   100000000 kB
SwapTotal:       8388604 kB
### disks
NAME="sda" MODEL="PERC H730P Mini" SIZE="1999844147200" ROTA="1" TYPE="disk"
NAME="nvme0n1" MODEL="Samsung SSD 980 PRO 1TB" SIZE="1000204886016" ROTA="0" TYPE="disk"
NAME="sr0" MODEL="DVD" SIZE="1073741312" ROTA="1" TYPE="rom"
NAME="loop0" MODEL="" SIZE="1000" ROTA="0" TYPE="loop"
### fs
Filesystem     Type 1-blocks Used Available Capacity Mounted on
/dev/mapper/pve-root ext4 100000000000 25000000000 75000000000 25% /
/dev/nvme0n1p1 xfs 900000000000 1000 899999999000 1% /mnt/fast data
/dev/loop3 squashfs 1000 1000 0 100% /snap/core/1
### link
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
2: eno1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq master vmbr0 state UP mode DEFAULT group default qlen 1000\\    link/ether aa:bb:cc:dd:ee:01 brd ff:ff:ff:ff:ff:ff
3: vmbr0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000\\    link/ether AA:BB:CC:DD:EE:01 brd ff:ff:ff:ff:ff:ff
4: docker0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue state DOWN\\    link/ether 02:42:00:00:00:01 brd ff:ff:ff:ff:ff:ff
5: br-0123456789ab: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP\\    link/ether 02:42:00:00:00:02 brd ff:ff:ff:ff:ff:ff
6: veth1a2b3c@if5: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 master docker0 state UP\\    link/ether 02:42:00:00:00:03 brd ff:ff:ff:ff:ff:ff
7: tap100i0: <BROADCAST,MULTICAST,PROMISC,UP,LOWER_UP> mtu 1500 master fwbr100i0 state UNKNOWN\\    link/ether 02:00:00:00:00:04 brd ff:ff:ff:ff:ff:ff
### addr
1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever
3: vmbr0    inet 10.0.0.5/24 scope global vmbr0\\       valid_lft forever preferred_lft forever
3: vmbr0    inet6 2001:db8::5/64 scope global\\       valid_lft forever preferred_lft forever
3: vmbr0    inet6 fe80::a8bb:ccff:fedd:ee01/64 scope link\\       valid_lft forever preferred_lft forever
4: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever
5: br-0123456789ab    inet 172.18.0.1/16 brd 172.18.255.255 scope global br-0123456789ab\\       valid_lft forever preferred_lft forever
### route
default via 10.0.0.1 dev vmbr0 proto kernel onlink
### dns
nameserver 127.0.0.53
### dns2
Global:
Link 3 (vmbr0): 10.0.0.1 1.1.1.1
`;

test("Linux card: hardware, disks without loop/rom, real NICs only, upstream DNS", () => {
  const f = parseLinuxFacts(LINUX, 1000);
  expect(f).toMatchObject({
    hostname: "pve1.lan",
    os: "Debian GNU/Linux 12 (bookworm)",
    kernel: "6.8.12-4-pve",
    uptimeSec: 86401,
    virtualization: "none",
    vendor: "Dell Inc. PowerEdge R640",
    cpu: { model: "Intel(R) Xeon(R) Gold 6126 CPU @ 2.60GHz", sockets: 2, cores: 24, threads: 48 },
    memory: { totalBytes: 263840000 * 1024, availableBytes: 100000000 * 1024, swapBytes: 8388604 * 1024 },
    gateway: "10.0.0.1",
    dns: ["10.0.0.1", "1.1.1.1"],
  });
  expect(f.disks).toEqual([
    { name: "sda", model: "PERC H730P Mini", sizeBytes: 1999844147200, rotational: true },
    { name: "nvme0n1", model: "Samsung SSD 980 PRO 1TB", sizeBytes: 1000204886016, rotational: false },
  ]);
  expect(f.filesystems.map((x) => x.mount)).toEqual(["/", "/mnt/fast data"]);
  expect(f.interfaces).toEqual([{ name: "vmbr0", mac: "aa:bb:cc:dd:ee:01", up: true, addresses: ["10.0.0.5/24", "2001:db8::5/64"] }]);
  expect(factsMarkdown(f)).toContain("vmbr0 10.0.0.5/24");
});

test("Windows card from the PowerShell JSON, one-element arrays and vEthernet noise", () => {
  const json = JSON.stringify({
    hostname: "dc1.corp.local",
    os: "Microsoft Windows Server 2022 Standard 10.0.20348",
    kernel: "10.0.20348",
    uptimeSec: 3600,
    manufacturer: "Microsoft Corporation",
    model: "Virtual Machine",
    cpuModel: "AMD EPYC 7543 32-Core Processor",
    sockets: 1,
    cores: 4,
    threads: 4,
    memTotal: 8589934592,
    memFree: 2147483648,
    swap: 1342177280,
    disks: { name: "Disk 0", model: "Microsoft Virtual Disk", size: 136365211648, media: "Unspecified" },
    fs: { mount: "C:", fstype: "NTFS", size: 136000000000, free: 36000000000 },
    nics: [
      { name: "Ethernet", mac: "00-15-5D-01-02-03", up: true, addresses: ["10.1.0.10/24", "fe80::1%4/64"] },
      { name: "vEthernet (nat)", mac: "00-15-5D-0A-0B-0C", up: true, addresses: ["172.20.0.1/20"] },
    ],
    gateway: "10.1.0.1",
    dns: "10.1.0.2",
  });
  const f = parseWindowsFacts(`#< CLIXML\r\n${json}`, 5);
  expect(f).toMatchObject({ hostname: "dc1.corp.local", virtualization: "microsoft", gateway: "10.1.0.1", dns: ["10.1.0.2"] });
  expect(f.disks).toEqual([{ name: "Disk 0", model: "Microsoft Virtual Disk", sizeBytes: 136365211648, rotational: null }]);
  expect(f.filesystems).toEqual([{ mount: "C:", fstype: "NTFS", sizeBytes: 136000000000, usedBytes: 100000000000 }]);
  expect(f.interfaces).toEqual([{ name: "Ethernet", mac: "00:15:5d:01:02:03", up: true, addresses: ["10.1.0.10/24"] }]);
});

test("node OS follows the card; proxmox stays proxmox, unknown distros keep the admin's choice", () => {
  const card = (os: string) => ({ os }) as Parameters<typeof osFromFacts>[0];
  expect(osFromFacts(card("Microsoft Windows Server 2022 Standard 10.0.20348"), "ubuntu")).toBe("windows");
  expect(osFromFacts(card("Ubuntu 24.04.1 LTS"), "other")).toBe("ubuntu");
  expect(osFromFacts(card("Debian GNU/Linux 12 (bookworm)"), "ubuntu")).toBe("debian");
  expect(osFromFacts(card("Debian GNU/Linux 12 (bookworm)"), "proxmox")).toBe("proxmox");
  expect(osFromFacts(card("Rocky Linux 9.4"), "other")).toBe("other");
});
