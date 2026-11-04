// WireGuard client config validator: a whitelist of keys, every peer is a remote server with an Endpoint.
// Keys are x25519: 32 bytes → base64 = 44 chars ending with '='.

// 32 bytes → base64 = 44 chars, exactly one '=' padding.
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

export interface PeerInfo {
  publicKey: string;
  endpoint?: string;
  allowedIPs: string[];
}

export interface ValidateResult {
  errors: string[];
  peers: PeerInfo[];
  address: string[];
}

// Parse and validate a WireGuard config text.
// Returns parsed peers/address for convenience; errors list drives rejection.
export function validateConf(text: string): ValidateResult {
  const errors: string[] = [];
  const peers: PeerInfo[] = [];
  const address: string[] = [];
  let section: "Interface" | "Peer" | null = null;
  let hasInterface = false;
  let hasPrivateKey = false;
  let peerCount = 0;
  let tableOff = false;
  const fullTunnelIPs: string[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    if (line === "[Interface]") {
      section = "Interface";
      hasInterface = true;
      continue;
    }
    if (line === "[Peer]") {
      section = "Peer";
      peerCount++;
      peers.push({ publicKey: "", allowedIPs: [] });
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) {
      errors.push(`неверный формат строки: ${line}`);
      continue;
    }

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (section === "Interface") {
      switch (key) {
        case "PrivateKey":
          if (!KEY_RE.test(value)) errors.push("PrivateKey должен быть 44 знаками base64, оканчивающимися на =");
          else hasPrivateKey = true;
          break;
        case "Address":
          address.push(value);
          break;
        case "ListenPort":
          errors.push("ListenPort не нужен: плагин — только клиент, входящие подключения не принимает");
          break;
        case "MTU":
        case "FwMark":
          // accepted, no validation needed
          break;
        case "Table":
          if (value === "off") tableOff = true;
          break;
        case "DNS":
          errors.push("DNS не поддерживается: в этом контейнере отсутствует resolvconf; настройте DNS на хостах");
          break;
        default:
          errors.push(`неизвестный ключ "${key}" в секции [Interface]`);
      }
    } else if (section === "Peer") {
      switch (key) {
        case "PublicKey":
          if (!KEY_RE.test(value)) errors.push("PublicKey должен быть 44 знаками base64, оканчивающимися на =");
          else peers[peers.length - 1].publicKey = value;
          break;
        case "PresharedKey":
          if (!KEY_RE.test(value)) errors.push("PresharedKey должен быть 44 знаками base64, оканчивающимися на =");
          break;
        case "Endpoint":
          peers[peers.length - 1].endpoint = value;
          break;
        case "AllowedIPs": {
          const ips = value.split(",").map((s) => s.trim());
          // Table = off may come after [Peer], so the decision is made after the loop.
          fullTunnelIPs.push(...ips.filter((ip) => ip === "0.0.0.0/0" || ip === "::/0"));
          peers[peers.length - 1].allowedIPs = ips;
          break;
        }
        case "PersistentKeepalive":
          break;
        case "PreUp":
        case "PostUp":
        case "PreDown":
        case "PostDown":
        case "SaveConfig":
          errors.push(`ключ "${key}" не поддерживается в секции [Peer]`);
          break;
        default:
          errors.push(`неизвестный ключ "${key}" в секции [Peer]`);
      }
    } else {
      errors.push("нет секции [Interface] или [Peer]");
    }
  }

  if (!tableOff) for (const ip of fullTunnelIPs) errors.push(`${ip} запрещён: полный туннель уведёт весь трафик контейнера, включая доступ к LLM`);
  if (!hasInterface) errors.push("отсутствует секция [Interface]");
  if (!hasPrivateKey) errors.push("в секции [Interface] отсутствует PrivateKey");
  if (peerCount === 0) errors.push("добавьте хотя бы один [Peer]");
  if (peers.some((p) => !p.endpoint)) errors.push("у каждого [Peer] нужен Endpoint (адрес VPN-сервера): плагин — только клиент");
  if (peers.some((p) => !p.publicKey)) errors.push("у каждого [Peer] должен быть PublicKey");

  return { errors, peers, address };
}
