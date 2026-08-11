<div align="center">

<img src="icon.png" alt="PeakGuard" width="128" height="128" />

# PeakGuard

**Know before you call. Save before you burn.**

DeepSeek V4 charges 2× during Beijing business hours.  
PeakGuard shows you exactly where you stand — before you burn budget on a peak-hour Composer session.

[![Version](https://img.shields.io/badge/version-1.3.0-blue?style=flat-square)](https://github.com/macdev-stdmyapis01/ai-pulse)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-blue?style=flat-square)](https://code.visualstudio.com)
[![Cursor](https://img.shields.io/badge/Cursor-compatible-purple?style=flat-square)](https://cursor.sh)

</div>

---

## Why PeakGuard

DeepSeek introduced time-based pricing for V4 — the first major AI provider to do so. During peak hours (Beijing business hours), every API call costs **2× the normal rate**. A single heavy Composer session can silently cost double without any warning.

PeakGuard puts the status in your status bar. One glance tells you whether to run that refactor now or wait 20 minutes.

---

## Status Bar States

| State | Display | Color | Meaning |
|---|---|---|---|
| Off-peak | `◉ DS · off-peak · $0.14/M` | 🟢 Emerald | Safe — run heavy sessions now |
| Approaching | `◑ DS · peak in 18m · $0.14/M` | 🟡 Yellow | Finish your session soon |
| Peak window | `⏸ DS · peak window · $0.14/M` | 🟠 Amber | Surcharge window active |
| Peak active | `⚡ DS · PEAK · $0.28/M` | 🟠 Amber | Costs 2× — switch or wait |

> The 2× surcharge has been announced by DeepSeek but is not yet enforced. PeakGuard tracks the windows now so you're ready the moment it activates.

---

## Peak Windows

DeepSeek V4 peak hours run twice daily on Beijing time:

| Beijing (CST) | UTC | Impact |
|---|---|---|
| 09:00 – 12:00 | 01:00 – 04:00 | 2× input + output pricing |
| 14:00 – 18:00 | 06:00 – 10:00 | 2× input + output pricing |

PeakGuard converts these to **your local timezone automatically** — no configuration required. A developer in New York, London, or Mumbai all see the correct local times.

---

## Features

- **Zero configuration** — installs and works immediately with DeepSeek V4-Flash pre-configured
- **Timezone-safe** — all logic runs on UTC internally; display uses your OS timezone automatically
- **Remote SSH aware** — set `peakGuard.displayTimezone` if your server timezone differs from your local machine
- **Hover tooltip** — shows current pricing, next peak time in your local timezone, and a smart suggestion
- **Click panel** — opens a detail view with pricing breakdown, peak windows, and next transition time
- **Command palette** — switch providers or add custom providers without touching config files
- **Extensible** — add any provider with custom peak windows and pricing via `settings.json`
- **Zero network calls** — all logic is local time math; works offline, no telemetry

---

## Quick Start

### Install from VSIX

```bash
cursor --install-extension peakguard-1.1.0.vsix
# or
code --install-extension peakguard-1.1.0.vsix
```

### Install from Source

```bash
git clone https://github.com/macdev-stdmyapis01/ai-pulse.git
cd ai-pulse/peakguard
npm install --save-dev typescript @types/vscode@1.85.0 @types/node
npx tsc
vsce package
cursor --install-extension peakguard-1.1.0.vsix
```

---

## Commands

| Command | Description |
|---|---|
| `PeakGuard: Switch Provider` | Change the active provider shown in the status bar |
| `PeakGuard: Add Provider` | Add a custom provider with your own peak windows and pricing |
| `PeakGuard: Open Panel` | Open the detail panel (or click the status bar item) |
| `PeakGuard: Refresh` | Force reload of config and state |

---

## Add Your Own Providers

PeakGuard is built for any LLM API provider, not just DeepSeek. Add a provider in 60 seconds via command palette:

```
> PeakGuard: Add Provider
```

Or directly in `settings.json`:

```json
{
  "peakGuard.providers": [
    {
      "id": "my-groq",
      "name": "Groq Llama-70B",
      "model": "llama-3.3-70b-versatile",
      "shortLabel": "GQ",
      "timezone": "America/Chicago",
      "peak_pricing_active": false,
      "peak_pricing_announced": false,
      "pricing": {
        "offpeak": { "input_miss": 0.00, "input_hit": 0.00, "output": 0.00 },
        "peak":    { "input_miss": 0.00, "input_hit": 0.00, "output": 0.00 }
      },
      "peak_windows": [],
      "warning_minutes": 20,
      "source": "https://console.groq.com",
      "last_verified": "2026-08-10"
    }
  ]
}
```

---

## Settings Reference

| Setting | Default | Description |
|---|---|---|
| `peakGuard.activeProvider` | `deepseek-v4-flash` | ID of the currently active provider |
| `peakGuard.warningMinutes` | `20` | Minutes before peak to show the approaching state |
| `peakGuard.showPrice` | `true` | Show input price per 1M tokens in the status bar |
| `peakGuard.currency` | `USD` | Currency for price display (`USD` or `EUR`) |
| `peakGuard.displayTimezone` | `auto` | Your local timezone for display. Set explicitly when using Remote SSH (e.g. `America/New_York`) |
| `peakGuard.providers` | `[]` | Array of custom provider definitions |

---

## How It Works

PeakGuard is intentionally simple. The entire peak calculation is pure UTC time math with no network dependency:

```
Every 60 seconds:
  get current UTC time
  compare against provider peak windows (stored in UTC)
  if inside peak window  → PEAK state
  if within warning_minutes of peak → APPROACHING state
  otherwise → OFFPEAK state

Display times are converted to your OS timezone for readability.
Peak logic never touches your local timezone — timezone-safe by design.
```

---

## **DeepSeek V4 Pricing Reference**

### **V4-Flash**

| | Cache Miss | Cache Hit | Output |
|---|---|---|---|
| **Off-peak** | $0.14 / 1M | $0.0028 / 1M | $0.28 / 1M |
| **Peak (2×)** | $0.28 / 1M | $0.0056 / 1M | $0.56 / 1M |

### **V4-Pro**

| | Cache Miss | Cache Hit | Output |
|---|---|---|---|
| **Off-peak** | $0.435 / 1M | $0.0036 / 1M | $0.87 / 1M |
| **Peak (2×)** | $0.870 / 1M | $0.0072 / 1M | $1.74 / 1M |

Cache hits are ~98% cheaper than cache misses. On a heavy 8-turn Composer session with an 80K-token context, staying off-peak saves approximately 68% of total input costs.

---

## Resource Footprint

| Resource | Usage |
|---|---|
| RAM (idle) | ~2–4 MB |
| RAM (panel open) | ~10–16 MB |
| Disk | ~500 KB installed |
| Network | Zero — all logic is local |
| CPU | <0.5ms per 60-second tick |

---

## **Roadmap**

- [x] v1.1 — Full pricing fields (cache miss, cache hit, output) for add provider flow
- [ ] v1.2 — Inline Add Provider form in panel (no command palette needed)
- [ ] v1.3 — Remote config feed for live pricing updates without extension updates
- [ ] v2.0 — Native Marketplace publish under Nagvera Technologies

---

## Contributing

Contributions welcome. If a provider's peak windows change or pricing updates, open a PR against `providers.json` — that's the fastest path to keeping data current for everyone.

1. Fork the repo
2. Update `providers.json` with corrected data and a new `last_verified` date
3. Open a PR with a link to the official pricing source

---

## License

MIT © [Nagvera Technologies](https://github.com/macdev-stdmyapis01)

---

<div align="center">

Built for developers who run heavy AI Composer sessions and want to stop paying double without knowing it.

**[Report a PeakGuard issue](https://github.com/macdev-stdmyapis01/ai-pulse/issues/new?labels=peakguard,bug&title=[PeakGuard]) · [Request a feature](https://github.com/macdev-stdmyapis01/ai-pulse/issues/new?labels=peakguard,enhancement&title=[PeakGuard])**

</div>
