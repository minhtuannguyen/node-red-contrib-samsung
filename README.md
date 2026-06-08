# node-red-contrib-samsung

Node-RED nodes for controlling a **Samsung Tizen TV** over the local network via WebSocket.

Key difference from other Samsung plugins: **if the TV is hard-powered off and unreachable on the network, it is treated as "off" — no errors, no crashed flows.**

---

## Requirements

- Samsung Tizen TV (2017 or newer)
- TV connected via Ethernet or Wi-Fi to the same local network as Node-RED
- Node-RED 2.0 or newer
- Node.js 14 or newer

---

## Installation

### From GitHub (recommended — no `npm install` needed on the device)

```bash
cd ~/.node-red
npm install https://github.com/minhtuannguyen/node-red-contrib-samsung
```

Then restart Node-RED:

```bash
sudo systemctl restart nodered
# or
node-red-restart
```

---

## Nodes

After installation three nodes appear in the **Samsung** palette category.

---

### samsung-tv-config *(configuration node)*

Shared connection settings used by all other Samsung nodes. Not visible in the flow canvas — it appears as a selectable config inside the other nodes.

| Field | Description |
|---|---|
| **Name** | Display label in the editor |
| **IP Address** | Local IP of the TV. Assign a static IP or DHCP reservation so it never changes. |
| **Client Name** | Name shown on the TV pairing dialog (default: `NodeRED`) |
| **MAC Address** | Required for Wake-on-LAN (powering on a fully off TV) |
| **Pairing Token** | Leave blank initially — auto-filled after first pairing |
| **Legacy Mode** | Enable for older TVs (pre-2018) that use plain WS on port 8001 without token auth |

---

### samsung-tv-command

Sends a command to the TV. Three modes selectable via dropdown:

#### Mode: Send Key

Sends a remote-control key press via WebSocket.

**Inputs**

| Property | Type | Description |
|---|---|---|
| `msg.payload` | `string` | Key name, e.g. `"KEY_MUTE"`. Overrides the key selected in the editor. |
| `msg.payload` | `object` | `{ key, hold, repeat, delay }` — see options below |
| `msg.payload` | `array` | Sequence of string or object commands |

Key object options:

| Option | Type | Default | Description |
|---|---|---|---|
| `key` | string | — | Samsung key name (required) |
| `hold` | number (ms) | `0` | Press-and-hold duration. `0` = single click |
| `repeat` | number | `1` | Number of times to send the key |
| `delay` | number (ms) | `400` | Pause between repeated sends and after the command |

**Common key names**

| Key | Action |
|---|---|
| `KEY_POWER` | Power |
| `KEY_MUTE` | Mute |
| `KEY_VOLUP` / `KEY_VOLDOWN` | Volume up / down |
| `KEY_UP` / `KEY_DOWN` / `KEY_LEFT` / `KEY_RIGHT` | Navigation |
| `KEY_ENTER` | OK / Enter |
| `KEY_RETURN` | Back |
| `KEY_HOME` | Home screen |
| `KEY_SOURCE` | Source / Input |
| `KEY_HDMI` | HDMI |
| `KEY_CHUP` / `KEY_CHDOWN` | Channel up / down |
| `KEY_PLAY` / `KEY_PAUSE` / `KEY_STOP` | Playback |
| `KEY_FF` / `KEY_REWIND` | Fast forward / rewind |
| `KEY_0` – `KEY_9` | Number keys |
| `KEY_RED` / `KEY_GREEN` / `KEY_YELLOW` / `KEY_BLUE` | Colour buttons |

#### Mode: Launch App

Launches a Samsung TV app via the local REST API (port 8001).

| Property | Type | Description |
|---|---|---|
| `msg.payload` | `string` | Samsung App ID. Overrides the App ID set in the editor. |

#### Mode: Pair TV

Connects to the TV to trigger the on-screen pairing dialog. Accept it once with the TV remote — the token is saved automatically to the config node. You only need to do this once per TV.

**Outputs** (all modes)

| Output | Description |
|---|---|
| 1 — Success | `{ payload: true, status: "ok" }` |
| 2 — Offline / Error | `{ payload: null, status: "offline" }` if TV unreachable; `{ payload: null, status: "error", error: "..." }` on failure |

> When the TV is hard-powered off, output 2 fires with `status: "offline"` — the flow continues normally.

---

### samsung-tv-power

Controls the power state of the TV with Wake-on-LAN support.

**Input**

| `msg.payload` | Action |
|---|---|
| `true` / `"on"` / any non-zero number | Turn on |
| `false` / `"off"` / `0` | Turn off |
| `"toggle"` | Reverse current state |
| `"status"` | Report current state, no action |

**Power-on behaviour**

| TV state | Action taken |
|---|---|
| Hard off (port unreachable) | Wake-on-LAN magic packet sent — requires MAC address in config |
| Soft standby (port reachable, PowerState = standby) | `KEY_POWER` via WebSocket |
| Already on | No action |

**Power-off behaviour**

| TV state | Action taken |
|---|---|
| Hard off (unreachable) | No action — already off, no error |
| On or standby | `KEY_POWER` via WebSocket |

**Output**

| Property | Type | Description |
|---|---|---|
| `msg.payload` | `boolean` | `true` = on, `false` = off |
| `msg.state` | `string` | `"on"`, `"standby"`, or `"offline"` |

---

## First-time Setup

1. **Add a config node** — in any Samsung node editor, click the pencil icon next to the TV field and fill in IP address and MAC address.

2. **Pair the TV** — add a `samsung-tv-command` node, set mode to **Pair TV**, connect an inject node and deploy. Trigger it once — the TV shows a dialog on screen. Accept it with the TV remote. The token is saved automatically.

3. **Done** — all nodes are now ready to use. The pairing token persists across Node-RED restarts.

---

## Example Flow

```json
[
  {
    "id": "inj1", "type": "inject", "name": "Mute",
    "payload": "KEY_MUTE", "payloadType": "str",
    "wires": [["cmd1"]]
  },
  {
    "id": "cmd1", "type": "samsung-tv-command",
    "name": "", "tv": "<your-config-node-id>",
    "mode": "key", "defaultKey": "KEY_MUTE",
    "wires": [["dbg1"], ["dbg1"]]
  },
  {
    "id": "dbg1", "type": "debug", "name": "result"
  }
]
```

---

## Troubleshooting

**Nodes show "unknown node type" after install**
Run `npm install` inside the plugin folder on the device, then restart Node-RED.

**Commands connect but TV does nothing**
The TV needs ~1 second after the WebSocket channel opens before it accepts commands. This delay is built in. If it still doesn't work, check that pairing was accepted and the token is saved in the config node.

**Wake-on-LAN does not work**
- Ensure the MAC address is correct (found in TV Settings → Network → Network Status → MAC Address)
- Enable Wake-on-LAN in TV Settings → General → Network → Expert Settings → Power On with Mobile
- The Pi and TV must be on the same subnet, or the WoL broadcast address must be adjusted

**TV shows pairing dialog every time**
The token was not saved. Open the config node and confirm the Pairing Token field is populated. If blank, run Pair mode again and accept on the TV.

---

## License

MIT