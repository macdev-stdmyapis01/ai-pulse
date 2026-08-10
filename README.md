# DeepSeek Pulse

> Know when DeepSeek API costs 2×. Beat peak hours. Cut your API bill.

DeepSeek V4 charges 2× during Beijing business hours. This extension shows you exactly where you stand — before you burn budget on a peak-hour Composer session.

```
◉ DS · off-peak · $0.14/M     safe to run
◑ DS · peak in 18m · $0.14/M  finish soon
⚡ DS · PEAK · $0.28/M        switch provider or wait
```

---

## Install

Install from the VS Code Marketplace or:

```bash
code --install-extension deepseek-pulse-1.0.0.vsix
```

Works immediately after install — no configuration required.

---

## Peak windows

DeepSeek V4-Flash peak hours (Beijing time / UTC):

| Beijing | UTC | Your cost |
|---|---|---|
| 09:00 – 12:00 | 01:00 – 04:00 | 2× normal |
| 14:00 – 18:00 | 06:00 – 10:00 | 2× normal |
| All other hours | Off-peak | Normal rate |

> **Note:** 2× surcharge has been announced but is not yet live as of August 2026.
> The extension tracks peak windows now so you are ready when it activates.

---

## Status bar states

| State | Display | Color | Meaning |
|---|---|---|---|
| Off-peak | `◉ DS · off-peak · $0.14/M` | Emerald | Safe to run heavy sessions |
| Approaching | `◑ DS · peak in 18m · $0.14/M` | Yellow | Finish your session soon |
| Peak | `⚡ DS · PEAK · $0.28/M` | Amber | Costs 2× — switch or wait |

---

## Commands

| Command | What it does |
|---|---|
| `DeepSeek Pulse: Switch Provider` | Change the active provider shown in the status bar |
| `DeepSeek Pulse: Add Provider` | Add a custom provider with your own peak windows and pricing |
| `DeepSeek Pulse: Open Panel` | Open the detail panel (or click the status bar item) |
| `DeepSeek Pulse: Refresh` | Force a reload of config and state |

---

## Add your own providers

Via command palette: `> DeepSeek Pulse: Add Provider`

Or directly in `settings.json`:

```json
{
  "deepseekPulse.providers": [
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
      "source": "https://console.groq.com/docs/rate-limits",
      "last_verified": "2026-08-09"
    }
  ]
}
```

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `deepseekPulse.activeProvider` | `deepseek-v4-flash` | Currently active provider ID |
| `deepseekPulse.warningMinutes` | `20` | Minutes before peak to show approaching state |
| `deepseekPulse.showPrice` | `true` | Show price per 1M tokens in status bar |
| `deepseekPulse.currency` | `USD` | Currency for price display |
| `deepseekPulse.displayTimezone` | `auto` | Your display timezone. Set explicitly if using Remote SSH |
| `deepseekPulse.providers` | `[]` | Custom provider definitions |

### Remote SSH note

If you use Cursor with Remote SSH, the extension runs on the remote machine. Set `displayTimezone` to your local timezone so peak times display correctly:

```json
{
  "deepseekPulse.displayTimezone": "America/New_York"
}
```

---

## How it works

- Peak windows are stored in UTC — your OS timezone never affects the calculation
- Status bar updates every 60 seconds
- Zero network calls — all logic is local time math
- Works offline, works across timezones, works on Remote SSH

---

## Resource usage

| Resource | Usage |
|---|---|
| RAM | ~2–4 MB idle |
| Disk | ~500 KB installed |
| Network | Zero outbound calls |
| CPU | <0.5ms per 60-second tick |

---

## License

MIT
