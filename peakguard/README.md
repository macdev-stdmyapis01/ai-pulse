<div align="center">

<img src="icon.png" alt="PeakGuard" width="128" height="128" />

# PeakGuard

**Know before you call. Save before you burn.**

DeepSeek V4 has announced 2× pricing during Beijing business hours.
PeakGuard shows you exactly where you stand — before you burn budget on a peak-hour Composer session.

[![Version](https://img.shields.io/badge/version-1.3.2-blue?style=flat-square)](https://github.com/macdev-stdmyapis01/ai-pulse)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-blue?style=flat-square)](https://code.visualstudio.com)
[![Cursor](https://img.shields.io/badge/Cursor-compatible-purple?style=flat-square)](https://cursor.sh)

</div>

---

## Why PeakGuard

DeepSeek has introduced time-based pricing for V4 — the first major AI provider to do so. During peak hours (Beijing business hours), API calls are billed at **2× the normal rate**. As of this writing, the surcharge has been **announced but is not yet live** — PeakGuard tracks the windows now so you already know your exposure the moment it activates.

PeakGuard puts the status in your status bar. One glance tells you whether to run a heavy Composer session now or wait.

---

## Status Bar States

| State | Display | Color | Meaning |
|---|---|---|---|
| Off-peak | `◉ DS · off-peak · $0.14/M` | 🟢 Emerald | Normal pricing — run heavy sessions now |
| Approaching | `◑ DS · peak in 18m · $0.14/M` | 🟡 Yellow | Still off-peak, but a window starts soon |
| Peak window (announced, not yet live) | `⏸ DS · peak window · $0.14/M` | 🟠 Amber | Inside a scheduled peak window, but the surcharge isn't enforced yet — pricing shown is still the off-peak rate |
| Peak active | `⚡ DS · PEAK · $0.28/M` | 🔴 Red | Surcharge is live — costs 2× — switch provider or wait |

Only the **Peak active** state reflects real 2× pricing. **Peak window** is a heads-up: you're in the scheduled window, but the surcharge flag (`peak_pricing_active`) hasn't flipped on yet for this provider.

---

## Peak Windows

DeepSeek V4's announced peak hours run twice daily on Beijing time:

| Beijing (CST) | UTC | Impact once live |
|---|---|---|
| 09:00 – 12:00 | 01:00 – 04:00 | 2× input + output pricing |
| 14:00 – 18:00 | 06:00 – 10:00 | 2× input + output pricing |

**Timezone handling:** peak-window math always runs on UTC internally, so the logic itself never depends on where the extension host is running. Displayed times, however, are resolved and formatted **inside the webview panel** (client-side JavaScript), so they always reflect the timezone of the machine you're actually looking at the panel on — your laptop — even if the extension host is running remotely (see below).

---

## Features

- **Zero configuration** — installs and works immediately with DeepSeek V4-Flash pre-configured
- **Timezone-correct by construction** — peak-window calculation runs entirely in UTC; the panel's displayed times are computed by the webview itself, not by the extension host, so they always match the timezone of whatever machine is rendering the UI
- **Correct under Remote-SSH** — if your extension host runs on a remote server (a different timezone than your laptop), display times are still resolved locally in the webview — no manual timezone override needed for this to work correctly
- **Hover tooltip** — shows current pricing, next peak time, and a smart suggestion
- **Click panel** — opens a detail view with pricing breakdown, peak windows, and next transition time
- **Command palette** — switch providers or add custom providers without touching config files
- **Extensible** — add any provider with custom peak windows and pricing via `settings.json`
- **Zero network calls** — all logic is local time math; works offline, no telemetry

---

## Quick Start

### Install from VSIX

```bash
cursor --install-extension peakguard-1.3.2.vsix
# or
code --install-extension peakguard-1.3.2.vsix
```

> **Remote-SSH / remote dev containers:** extensions in VS Code and Cursor install per connection target. If you work in a Remote-SSH window, run the install command (or use "Install from VSIX...") *inside that remote window*, not just on your local machine — the two have independent extension registries.

### Install from Source

```bash
git clone https://github.com/macdev-stdmyapis01/ai-pulse.git
cd ai-pulse/peakguard
npm install
npm run compile
npm run package
cursor --install-extension peakguard-1.3.2.vsix
```

---

## Commands

| Command | Description |
|---|---|
| `PeakGuard: Open Panel` | Open the detail panel (or click the status bar item) |
| `PeakGuard: Switch Provider` | Change the active provider shown in the status bar |
| `PeakGuard: Add Provider` | Add a custom provider with your own peak windows and pricing |
| `PeakGuard: Refresh` | Force reload of config and state |

---

## Add Your Own Providers

PeakGuard works with any LLM API provider, not just DeepSeek. Add one in under a minute via command palette:

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
      "warning_minutes": 20,
      "pricing": {
        "offpeak": { "input_miss": 0.00, "input_hit": 0.00, "output": 0.00 },
        "peak":    { "input_miss": 0.00, "input_hit": 0.00, "output": 0.00 }
      },
      "peak_windows": [
        { "start_utc": "01:00", "end_utc": "04:00" }
      ],
      "source": "https://console.groq.com",
      "last_verified": "2026-08-10"
    }
  ]
}
```

Custom providers merge with and can override the bundled ones.

---

## Settings Reference

| Setting | Type | Default | Description |
|---|---|---|---|
| `peakGuard.activeProvider` | string | `deepseek-v4-flash` | ID of the currently active provider |
| `peakGuard.warningMinutes` | number | `20` | Minutes (5–60) before a peak window to show the "approaching" state |
| `peakGuard.showPrice` | boolean | `true` | Show current price per 1M tokens in the status bar |
| `peakGuard.currency` | string | `USD` | Currency for price display (`USD` or `EUR`) |
| `peakGuard.displayTimezone` | string | `auto` | Reserved for the status-bar text and tooltip, which are rendered by the extension host. Set to an explicit IANA timezone (e.g. `America/New_York`) if you want the status bar / tooltip to show a fixed zone regardless of where the extension host runs. The panel itself always displays your local time automatically and does not use this setting. |
| `peakGuard.providers` | array | `[]` | Custom provider definitions. Merge with and can override bundled providers. |

---

## How It Works

```
Every 60 seconds:
  get current UTC time
  compare against provider peak windows (stored in UTC)
  if inside peak window and peak_pricing_active  → PEAK state (red, 2x pricing)
  if inside peak window and NOT peak_pricing_active → PEAK_ANNOUNCED state (amber, off-peak pricing still applies)
  if within warning_minutes of a peak window     → APPROACHING state (yellow)
  otherwise                                       → OFFPEAK state (green)
```

The state machine and all comparisons run in UTC — the extension host never needs to know its own timezone to compute state correctly.

Display formatting is a separate concern: the panel's peak-window times are converted to local time by JavaScript running inside the webview itself, using the browser environment's own timezone resolution (`Intl.DateTimeFormat`). Because the webview always renders on the machine you're looking at — even when the extension host runs on a remote server via Remote-SSH — displayed times are always correct for you without configuration.

---

## **DeepSeek V4 Pricing Reference**

Bundled provider data currently covers **V4-Flash** only (see `providers.json`). V4-Pro figures below are included for reference if you want to add it as a custom provider.

### V4-Flash *(bundled)*

| | Cache Miss | Cache Hit | Output |
|---|---|---|---|
| **Off-peak** | $0.14 / 1M | $0.0028 / 1M | $0.28 / 1M |
| **Peak (2×, once live)** | $0.28 / 1M | $0.0056 / 1M | $0.56 / 1M |

### V4-Pro *(not bundled — add manually)*

| | Cache Miss | Cache Hit | Output |
|---|---|---|---|
| **Off-peak** | $0.435 / 1M | $0.0036 / 1M | $0.87 / 1M |
| **Peak (2×, once live)** | $0.870 / 1M | $0.0072 / 1M | $1.74 / 1M |

Cache hits are roughly 98% cheaper than cache misses. On a heavy multi-turn Composer session with a large cached context, staying off-peak can meaningfully cut total input costs versus running the same session once the surcharge is live.

Pricing sourced from [DeepSeek's official pricing page](https://api-docs.deepseek.com/quick_start/pricing); verify against the source before relying on exact figures, as providers can change pricing without notice.

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

## Changelog

- **v1.3.2** — Fixed panel showing a redundant "surcharge announced" notice box alongside the suggestion box in the peak-announced state. Fixed cache miss/hit prices showing red (implying live 2× billing) during the announced-but-not-active state — now amber. Fixed peak window times displaying in UTC instead of local time when the extension host runs remotely (e.g. Remote-SSH) — conversion now happens client-side in the webview.
- **v1.3.1** — Prior stable release.
- **v1.1** — Full pricing fields (cache miss, cache hit, output) added to the Add Provider flow.

## Roadmap

- [ ] Inline Add Provider form in panel (no command palette needed)
- [ ] Remote config feed for live pricing updates without extension updates
- [ ] Native Marketplace publish under Nagvera Technologies

---

## Contributing

Contributions welcome. If a provider's peak windows change or pricing updates, open a PR against `providers.json` — that's the fastest path to keeping data current for everyone.

1. Fork the repo
2. Update `providers.json` with corrected data and a new `last_verified` date
3. Open a PR with a link to the official pricing source

---

## Known Limitations

- Extensions in VS Code / Cursor are installed **per connection target** (local machine, or each Remote-SSH host separately). If you use PeakGuard across multiple machines or remote hosts, install it in each one individually.
- `peakGuard.displayTimezone` only affects the status bar/tooltip text rendered by the extension host; it has no effect on the panel, which always uses the local machine's timezone automatically.

---

## License

MIT © [Nagvera Technologies](https://github.com/macdev-stdmyapis01)

---

<div align="center">

Built for developers who run heavy AI Composer sessions and want to stop paying double without knowing it.

**[Report a PeakGuard issue](https://github.com/macdev-stdmyapis01/ai-pulse/issues/new?labels=peakguard,bug&title=[PeakGuard]) · [Request a feature](https://github.com/macdev-stdmyapis01/ai-pulse/issues/new?labels=peakguard,enhancement&title=[PeakGuard])**

</div>
