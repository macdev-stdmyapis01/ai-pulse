import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
 
// ─────────────────────────────────────────────
// SECTION 1 — TYPES
// ─────────────────────────────────────────────
 
type PeakState = 'offpeak' | 'approaching' | 'peak' | 'peak_announced';
 
interface PeakWindow {
  start_utc: string;
  end_utc: string;
  startMin: number;
  endMin: number;
}
 
interface Pricing {
  input_miss: number;
  input_hit: number;
  output: number;
}
 
interface Provider {
  id: string;
  name: string;
  model: string;
  shortLabel: string;
  timezone: string;
  peak_pricing_active: boolean;
  peak_pricing_announced: boolean;
  pricing: { offpeak: Pricing; peak: Pricing };
  peak_windows: PeakWindow[];
  warning_minutes: number;
  source: string;
  last_verified: string;
}
 
interface StateResult {
  state: PeakState;
  minutesToNext: number;
  currentPricing: Pricing;
  activeWindow: PeakWindow | null;
}
 
interface AppConfig {
  activeProvider: string;
  showPrice: boolean;
  displayTimezone: string;
  providers: Provider[];
}
 
// ─────────────────────────────────────────────
// SECTION 2 — PEAK ENGINE
// ─────────────────────────────────────────────
 
const DAY_MIN = 1440;
 
function parseMin(t: string): number {
  const i = t.indexOf(':');
  return parseInt(t, 10) * 60 + parseInt(t.slice(i + 1), 10);
}
 
function utcMin(now: Date): number {
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}
 
function minsUntil(now: number, target: number): number {
  const d = target - now;
  return d > 0 ? d : d + DAY_MIN;
}
 
function inWindow(now: number, s: number, e: number): boolean {
  return s < e ? now >= s && now < e : now >= s || now < e;
}
 
function prepareWindows(raw: Array<{ start_utc: string; end_utc: string }>): PeakWindow[] {
  return raw.map(w => ({ ...w, startMin: parseMin(w.start_utc), endMin: parseMin(w.end_utc) }));
}
 
function calcState(nowMin: number, p: Provider): StateResult {
  for (const w of p.peak_windows) {
    if (inWindow(nowMin, w.startMin, w.endMin)) {
      let toEnd = w.endMin - nowMin;
      if (toEnd <= 0) { toEnd += DAY_MIN; }
      return {
        state: p.peak_pricing_active ? 'peak' : 'peak_announced',
        minutesToNext: toEnd,
        currentPricing: p.peak_pricing_active ? p.pricing.peak : p.pricing.offpeak,
        activeWindow: w
      };
    }
  }
  let minDist = Infinity;
  let nearest: PeakWindow | null = null;
  for (const w of p.peak_windows) {
    const d = minsUntil(nowMin, w.startMin);
    if (d < minDist) { minDist = d; nearest = w; }
  }
  return {
    state: minDist <= (p.warning_minutes ?? 20) ? 'approaching' : 'offpeak',
    minutesToNext: minDist,
    currentPricing: p.pricing.offpeak,
    activeWindow: nearest
  };
}
 
// ─────────────────────────────────────────────
// SECTION 3 — FORMATTING
// ─────────────────────────────────────────────
 
const STATE_COLOR: Record<PeakState, string> = {
  offpeak: '#34d399', approaching: '#fde047', peak: '#f59e0b', peak_announced: '#f59e0b'
};
 
function fmtMin(m: number): string {
  if (m < 60) { return `${Math.round(m)}m`; }
  const h = Math.floor(m / 60), min = Math.round(m % 60);
  return min === 0 ? `${h}h` : `${h}h ${min}m`;
}
 
function fmtPrice(n: number): string {
  return `$${n.toFixed(n < 0.01 ? 4 : 2)}/M`;
}
 
let _cachedTz: string | undefined;
function resolveZone(tz: string): string {
  if (tz !== 'auto') { return tz; }
  return _cachedTz ?? (_cachedTz = Intl.DateTimeFormat().resolvedOptions().timeZone);
}
 
function localTime(utcTime: string, zone: string): string {
  try {
    const [h, m] = utcTime.split(':').map(Number);
    const d = new Date(); d.setUTCHours(h, m, 0, 0);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: zone, timeZoneName: 'short' });
  } catch { return `${utcTime} UTC`; }
}
 
function barText(r: StateResult, p: Provider, showPrice: boolean): { text: string; color: string } {
  const price = showPrice ? ` · ${fmtPrice(r.currentPricing.input_miss)}` : '';
  const text = ({
    offpeak:        `◉ ${p.shortLabel} · off-peak${price}`,
    approaching:    `◑ ${p.shortLabel} · peak in ${fmtMin(r.minutesToNext)}${price}`,
    peak:           `⚡ ${p.shortLabel} · PEAK${price}`,
    peak_announced: `⏸ ${p.shortLabel} · peak window${price}`
  } as Record<PeakState, string>)[r.state];
  return { text, color: STATE_COLOR[r.state] };
}
 
// ─────────────────────────────────────────────
// SECTION 4 — TOOLTIP
// ─────────────────────────────────────────────
 
function buildTooltip(r: StateResult, p: Provider, zone: string): vscode.MarkdownString {
  const stateLabel = ({
    offpeak:        '◉ Off-peak',
    approaching:    `◑ Peak in ${fmtMin(r.minutesToNext)}`,
    peak:           '⚡ Peak active',
    peak_announced: '⏸ Peak window (surcharge not yet live)'
  } as Record<PeakState, string>)[r.state];
 
  const windowLines = p.peak_windows.map(
    w => `- ${w.start_utc}–${w.end_utc} UTC · ${localTime(w.start_utc, zone)} – ${localTime(w.end_utc, zone)}`
  ).join('\n');
 
  const nextLabel = r.state === 'peak' || r.state === 'peak_announced' ? 'Off-peak in' : 'Next peak in';
  const nextAt    = r.activeWindow ? ` · at ${localTime(r.activeWindow.start_utc, zone)}` : '';
  const notice    = p.peak_pricing_announced && !p.peak_pricing_active
    ? '\n\n---\n\n⚠ Surcharge **announced** — not yet live' : '';
 
  const md = new vscode.MarkdownString([
    `**PeakGuard** — ${p.name}`,
    `**Status** ${stateLabel}`,
    '---',
    `| | Per 1M tokens |\n|---|---|`,
    `| Input · cache miss | ${fmtPrice(r.currentPricing.input_miss)} |`,
    `| Input · cache hit  | ${fmtPrice(r.currentPricing.input_hit)} |`,
    `| Output             | ${fmtPrice(r.currentPricing.output)} |`,
    p.peak_windows.length > 0 ? `---\n\n**Peak windows**\n\n${windowLines}` : '',
    `**${nextLabel}** ${fmtMin(r.minutesToNext)}${nextAt}${notice}`,
    '---',
    '*Click to open panel*'
  ].filter(Boolean).join('\n\n'), true);
  md.isTrusted = true;
  return md;
}
 
// ─────────────────────────────────────────────
// SECTION 5 — PROVIDER LOADING
// ─────────────────────────────────────────────
 
const BUNDLED_IDS = new Set(['deepseek-v4-flash']);
 
function readConfig(): AppConfig {
  const c = vscode.workspace.getConfiguration('peakGuard');
  return {
    activeProvider:  c.get<string>('activeProvider', ''),
    showPrice:       c.get<boolean>('showPrice', true),
    displayTimezone: c.get<string>('displayTimezone', 'auto'),
    providers:       c.get<Provider[]>('providers', [])
  };
}
 
function loadBundled(ctx: vscode.ExtensionContext): Provider[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(ctx.extensionPath, 'providers.json'), 'utf8')).providers as Provider[];
    return parsed.map(p => ({ ...p, peak_windows: prepareWindows(p.peak_windows) }));
  } catch (e) {
    console.error('PeakGuard: failed to load providers.json', e);
    return [];
  }
}
 
function mergeProviders(bundled: Provider[], user: Provider[]): Provider[] {
  const map = new Map(bundled.map(p => [p.id, p]));
  for (const p of user) {
    map.set(p.id, { ...(map.get(p.id) ?? {}), ...p, peak_windows: prepareWindows(p.peak_windows ?? []) } as Provider);
  }
  return [...map.values()];
}
 
// ─────────────────────────────────────────────
// SECTION 6 — ADD PROVIDER FLOW
// ─────────────────────────────────────────────
 
const ADD_STEPS = [
  { group: 'Name',     prompt: 'Provider display name',                                 placeholder: 'e.g. Kimi K2.6',          numeric: false },
  { group: 'Off-peak', prompt: 'Input · Cache Miss per 1M tokens (USD)',                placeholder: '0.14',                     numeric: true  },
  { group: 'Off-peak', prompt: 'Input · Cache Hit per 1M tokens (USD)',                 placeholder: '0.0028',                   numeric: true  },
  { group: 'Off-peak', prompt: 'Output · Generated per 1M tokens (USD)',                placeholder: '0.28',                     numeric: true  },
  { group: 'Peak',     prompt: 'Input · Cache Miss per 1M (USD) — enter 0 if no peak', placeholder: '0.28',                     numeric: true  },
  { group: 'Peak',     prompt: 'Input · Cache Hit per 1M tokens (USD)',                 placeholder: '0.0056',                   numeric: true  },
  { group: 'Peak',     prompt: 'Output · Generated per 1M tokens (USD)',                placeholder: '0.56',                     numeric: true  },
  { group: 'Timezone', prompt: 'Timezone for peak windows',                             placeholder: 'Asia/Shanghai',            numeric: false, defaultVal: () => Intl.DateTimeFormat().resolvedOptions().timeZone },
  { group: 'Windows',  prompt: 'Peak windows in UTC — HH:MM-HH:MM, comma separated',  placeholder: '01:00-04:00, 06:00-10:00', numeric: false }
] as const;
 
async function addProviderFlow(): Promise<Provider | undefined> {
  const answers: string[] = [];
  for (let i = 0; i < ADD_STEPS.length; i++) {
    const s = ADD_STEPS[i];
    const val = await vscode.window.showInputBox({
      title:         `Add Provider (${i + 1}/${ADD_STEPS.length}) — ${s.group}`,
      prompt:        s.prompt,
      placeHolder:   s.placeholder,
      value:         'defaultVal' in s ? s.defaultVal() : undefined,
      validateInput: s.numeric ? v => isNaN(Number(v)) ? 'Enter a number' : null : undefined
    });
    if (val === undefined) { return; }
    answers.push(val);
  }
  const [name, offMiss, offHit, offOut, pkMiss, pkHit, pkOut, tz, wins] = answers;
  const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const rawWins = wins.split(',').map(s => s.trim()).filter(Boolean)
    .map(s => { const [a, b] = s.split('-').map(t => t.trim()); return { start_utc: a, end_utc: b }; })
    .filter(w => w.start_utc && w.end_utc);
  return {
    id, name, model: id,
    shortLabel: name.split(' ')[0],
    timezone: tz,
    peak_pricing_active:    Number(pkMiss) > 0,
    peak_pricing_announced: false,
    pricing: {
      offpeak: { input_miss: Number(offMiss), input_hit: Number(offHit), output: Number(offOut) },
      peak:    { input_miss: Number(pkMiss),  input_hit: Number(pkHit),  output: Number(pkOut)  }
    },
    peak_windows:    prepareWindows(rawWins),
    warning_minutes: 20,
    source:          '',
    last_verified:   new Date().toISOString().split('T')[0]
  };
}
 
// ─────────────────────────────────────────────
// SECTION 7 — PANEL HTML
// Explicit hex colors — no broken vscode color variables
// Inter + JetBrains Mono — premium typography
// ─────────────────────────────────────────────
 
function buildPanelHtml(
  r: StateResult,
  p: Provider,
  providers: Provider[],
  activeId: string,
  zone: string
): string {
  const isPeak   = r.state === 'peak' || r.state === 'peak_announced';
  const isOffpeak = !isPeak;
 
  const pillLabel = ({
    offpeak:        'Off-peak',
    approaching:    `Peak in ${fmtMin(r.minutesToNext)}`,
    peak:           'Peak active',
    peak_announced: 'Peak window'
  } as Record<PeakState, string>)[r.state];
 
  const sugText = ({
    offpeak:        `Good time to run Composer. Next peak in ${fmtMin(r.minutesToNext)}.`,
    approaching:    `Finish your session soon — peak starts in ${fmtMin(r.minutesToNext)}.`,
    peak:           `Peak hours active. Switch provider or wait ${fmtMin(r.minutesToNext)}.`,
    peak_announced: `Peak window active. Surcharge not yet live — monitor pricing page.`
  } as Record<PeakState, string>)[r.state];
 
  const altMiss  = isPeak ? p.pricing.offpeak.input_miss : p.pricing.peak.input_miss;
  const sepLabel = isPeak ? 'OFF-PEAK RATE' : 'PEAK RATE';
  const nextLabel = isPeak ? 'Off-peak in' : 'Next peak';
 
  // explicit color tokens — reliable across all Cursor themes
  const GREEN       = '#22c55e';
  const AMBER       = '#f59e0b';
  const RED         = '#ef4444';
  const pillBg      = isPeak ? 'rgba(245,158,11,0.12)' : 'rgba(34,197,94,0.10)';
  const pillColor   = isPeak ? AMBER  : GREEN;
  const pillBorder  = isPeak ? 'rgba(245,158,11,0.30)' : 'rgba(34,197,94,0.25)';
  const missColor   = isPeak ? RED    : GREEN;
  const hitColor    = isPeak ? RED    : GREEN;
  const nextColor   = isPeak ? RED    : AMBER;
  const sugBg       = isPeak ? 'rgba(245,158,11,0.08)' : 'rgba(34,197,94,0.07)';
  const sugColor    = isPeak ? '#d97706' : '#16a34a';
  const sugBorder   = isPeak ? 'rgba(245,158,11,0.25)' : 'rgba(34,197,94,0.20)';
  const sugIconPath = isOffpeak
    ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'
    : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>';
 
  const windowLines = p.peak_windows.map(w =>
    `<div class="t-row">
      <span class="t-label">${w.start_utc}–${w.end_utc} UTC</span>
      <span class="t-val mono">${localTime(w.start_utc, zone)} – ${localTime(w.end_utc, zone)}</span>
    </div>`
  ).join('');
 
  const providerRows = providers.map(p2 => {
    const r2      = calcState(utcMin(new Date()), p2);
    const isAct   = p2.id === activeId;
    const isBlt   = BUNDLED_IDS.has(p2.id);
    const dotCol  = ({ offpeak: GREEN, approaching: AMBER, peak: RED, peak_announced: AMBER } as Record<PeakState, string>)[r2.state];
    const sTxt    = ({ offpeak: 'off-peak', approaching: `peak in ${fmtMin(r2.minutesToNext)}`, peak: 'PEAK', peak_announced: 'peak window' } as Record<PeakState, string>)[r2.state];
    const sCol    = ({ offpeak: 'rgba(255,255,255,0.35)', approaching: AMBER, peak: RED, peak_announced: AMBER } as Record<PeakState, string>)[r2.state];
    const rowBg   = isAct ? (isPeak ? 'rgba(245,158,11,0.10)' : 'rgba(34,197,94,0.08)') : 'transparent';
    const rowBdr  = isAct ? (isPeak ? '0.5px solid rgba(245,158,11,0.28)' : '0.5px solid rgba(34,197,94,0.22)') : '0.5px solid transparent';
    const acBadge = isAct ? `<span class="badge" style="background:${isPeak ? 'rgba(245,158,11,0.14)' : 'rgba(34,197,94,0.11)'};color:${isPeak ? AMBER : GREEN};border:0.5px solid ${isPeak ? 'rgba(245,158,11,0.28)' : 'rgba(34,197,94,0.22)'}">active</span>` : '';
    const biBadge = isBlt ? `<span class="badge" style="background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.3);border:0.5px solid rgba(255,255,255,0.10)">built-in</span>` : '';
    const delBtn  = !isBlt ? `<button class="del" onclick="event.stopPropagation();deleteProvider('${p2.id}')" aria-label="Remove ${p2.name}">✕</button>` : '';
    return `<div class="prov-row" style="background:${rowBg};border:${rowBdr}" onclick="switchProvider('${p2.id}')">
      <div class="prov-left">
        <div class="prov-dot" style="background:${dotCol}"></div>
        <span class="prov-name">${p2.name}</span>
      </div>
      <div class="prov-right">
        <span class="prov-state" style="color:${sCol}">${sTxt}</span>
        ${acBadge}${biBadge}${delBtn}
      </div>
    </div>`;
  }).join('');
 
  const notice = p.peak_pricing_announced && !p.peak_pricing_active
    ? `<div style="margin:0 14px 8px;padding:6px 10px;border-radius:6px;background:rgba(245,158,11,0.08);border:0.5px solid rgba(245,158,11,0.25);color:#d97706;font-size:10px;display:flex;align-items:center;gap:5px">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        Surcharge announced — not yet live
      </div>`
    : '';
 
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src https://fonts.gstatic.com; style-src 'unsafe-inline' https://fonts.googleapis.com; script-src 'unsafe-inline';">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<title>PeakGuard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:12px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background,var(--vscode-editor-background,#1e1e1e))}
.mono{font-family:'JetBrains Mono',monospace}
.hdr{padding:12px 14px 10px;border-bottom:0.5px solid var(--vscode-panel-border,rgba(255,255,255,0.08));display:flex;justify-content:space-between;align-items:center}
.hdr-title{font-size:12px;font-weight:500;color:var(--vscode-foreground)}
.hdr-sub{font-size:10px;color:var(--vscode-foreground);opacity:0.4;margin-top:2px}
.pill{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:20px;font-size:10px;font-weight:500}
.pill-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
.section{padding:10px 14px;border-bottom:0.5px solid var(--vscode-panel-border,rgba(255,255,255,0.08))}
.row{display:flex;justify-content:space-between;align-items:center;padding:2.5px 0}
.lbl{font-size:11px;color:var(--vscode-foreground);opacity:0.5}
.val{font-size:11px;font-weight:500}
.val-dim{font-size:11px;color:var(--vscode-foreground);opacity:0.35}
.sep{display:flex;align-items:center;gap:6px;padding:5px 0}
.sep-line{flex:1;height:0.5px;background:var(--vscode-panel-border,rgba(255,255,255,0.08))}
.sep-txt{font-size:9px;color:var(--vscode-foreground);opacity:0.28;letter-spacing:0.05em}
.t-section{padding:8px 14px;border-bottom:0.5px solid var(--vscode-panel-border,rgba(255,255,255,0.08))}
.t-row{display:flex;justify-content:space-between;align-items:center;padding:2px 0}
.t-label{font-size:11px;color:var(--vscode-foreground);opacity:0.5}
.t-val{font-size:11px;color:var(--vscode-foreground)}
.sug{margin:8px 14px;padding:8px 10px;border-radius:7px;display:flex;gap:7px;align-items:flex-start;font-size:10.5px;line-height:1.5}
.sug svg{flex-shrink:0;margin-top:1px}
.providers{padding:8px 14px;border-top:0.5px solid var(--vscode-panel-border,rgba(255,255,255,0.08))}
.prov-hdr{font-size:9px;color:var(--vscode-foreground);opacity:0.28;letter-spacing:0.07em;margin-bottom:5px}
.prov-row{display:flex;align-items:center;justify-content:space-between;padding:4px 6px;border-radius:5px;cursor:pointer;margin-bottom:1px;transition:background 0.1s}
.prov-row:hover{background:rgba(255,255,255,0.05)!important}
.prov-left{display:flex;align-items:center;gap:6px}
.prov-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.prov-name{font-size:11px;color:var(--vscode-foreground);font-weight:500}
.prov-right{display:flex;align-items:center;gap:4px}
.prov-state{font-size:10px}
.badge{font-size:8px;padding:1px 4px;border-radius:3px;font-weight:500;white-space:nowrap}
.del{background:none;border:none;color:rgba(255,255,255,0.18);cursor:pointer;padding:1px 4px;border-radius:3px;font-size:10px;line-height:1;transition:color 0.1s,background 0.1s;font-family:inherit}
.del:hover{color:#ef4444;background:rgba(239,68,68,0.1)}
.actions{padding:10px 14px;border-top:0.5px solid var(--vscode-panel-border,rgba(255,255,255,0.08));display:flex;gap:7px}
.btn-p{flex:1;height:30px;padding:0 10px;background:rgba(255,255,255,0.92);color:#111;border:none;border-radius:6px;font-size:11px;font-weight:500;font-family:'Inter',-apple-system,sans-serif;cursor:pointer;transition:opacity 0.15s;display:flex;align-items:center;justify-content:center;gap:5px;letter-spacing:0.01em}
.btn-p:hover{opacity:0.85}
.btn-s{height:30px;padding:0 12px;background:transparent;color:var(--vscode-foreground);opacity:0.55;border:0.5px solid rgba(255,255,255,0.15);border-radius:6px;font-size:11px;font-family:'Inter',-apple-system,sans-serif;cursor:pointer;transition:all 0.12s;display:flex;align-items:center;justify-content:center;gap:5px;letter-spacing:0.01em}
.btn-s:hover{opacity:1;border-color:rgba(255,255,255,0.28);background:rgba(255,255,255,0.05)}
</style>
</head>
<body>
 
<div class="hdr">
  <div>
    <div class="hdr-title">PeakGuard</div>
    <div class="hdr-sub">${p.name}</div>
  </div>
  <div class="pill" style="background:${pillBg};color:${pillColor};border:0.5px solid ${pillBorder}">
    <div class="pill-dot"></div>${pillLabel}
  </div>
</div>
 
<div class="section">
  <div class="row"><span class="lbl">Input · cache miss</span><span class="val mono" style="color:${missColor}">${fmtPrice(r.currentPricing.input_miss)}</span></div>
  <div class="row"><span class="lbl">Input · cache hit</span><span class="val mono" style="color:${hitColor}">${fmtPrice(r.currentPricing.input_hit)}</span></div>
  <div class="row"><span class="lbl">Output</span><span class="val-dim mono">${fmtPrice(r.currentPricing.output)}</span></div>
  <div class="sep"><div class="sep-line"></div><span class="sep-txt">${sepLabel}</span><div class="sep-line"></div></div>
  <div class="row"><span class="lbl">Input · cache miss</span><span class="val-dim mono">${fmtPrice(altMiss)}</span></div>
</div>
 
<div class="t-section">
  <div class="t-row">
    <span class="t-label">${nextLabel}</span>
    <span class="t-val mono" style="color:${nextColor};font-weight:500">${fmtMin(r.minutesToNext)}</span>
  </div>
  ${windowLines}
</div>
 
<div class="sug" style="background:${sugBg};border:0.5px solid ${sugBorder};color:${sugColor}">
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${sugIconPath}</svg>
  ${sugText}
</div>
 
${notice}
 
<div class="providers">
  <div class="prov-hdr">PROVIDERS</div>
  ${providerRows}
</div>
 
<div class="actions">
  <button class="btn-p" onclick="addProvider()">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    Add Provider
  </button>
  <button class="btn-s" onclick="refresh()">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
    Refresh
  </button>
</div>
 
<script>
  const vscode = acquireVsCodeApi();
  function switchProvider(id) { vscode.postMessage({ command: 'switchProvider', id }); }
  function deleteProvider(id) { vscode.postMessage({ command: 'deleteProvider', id }); }
  function addProvider()      { vscode.postMessage({ command: 'addProvider' }); }
  function refresh()          { vscode.postMessage({ command: 'refresh' }); }
</script>
</body>
</html>`;
}
 
// ─────────────────────────────────────────────
// SECTION 8 — ACTIVATE
// ─────────────────────────────────────────────
 
export function activate(ctx: vscode.ExtensionContext): void {
  let providers: Provider[] = [];
  let activeId = '';
  let cfg      = readConfig();
  let panel: vscode.WebviewPanel | undefined;
 
  const peakGuardCfg = () => vscode.workspace.getConfiguration('peakGuard');
 
  function reload(): void {
    cfg       = readConfig();
    providers = mergeProviders(loadBundled(ctx), cfg.providers);
    activeId  = providers.find(p => p.id === cfg.activeProvider)
      ? cfg.activeProvider
      : (providers[0]?.id ?? '');
    _cachedTz = undefined;
  }
 
  function refreshPanel(): void {
    if (!panel) { return; }
    const p = providers.find(x => x.id === activeId) ?? providers[0];
    if (!p) { return; }
    const r = calcState(utcMin(new Date()), p);
    panel.webview.html = buildPanelHtml(r, p, providers, activeId, resolveZone(cfg.displayTimezone));
  }
 
  async function setActive(id: string): Promise<void> {
    activeId = id;
    await peakGuardCfg().update('activeProvider', id, vscode.ConfigurationTarget.Global);
    tick();
  }
 
  async function addProvider(): Promise<void> {
    const p = await addProviderFlow();
    if (!p) { return; }
    await peakGuardCfg().update('providers', [...cfg.providers, p], vscode.ConfigurationTarget.Global);
    reload(); tick(); refreshPanel();
    vscode.window.showInformationMessage(`PeakGuard: ${p.name} added.`);
  }
 
  async function deleteProvider(id: string): Promise<void> {
    await peakGuardCfg().update('providers', cfg.providers.filter(p => p.id !== id), vscode.ConfigurationTarget.Global);
    if (activeId === id) { activeId = providers.find(p => p.id !== id)?.id ?? ''; }
    reload(); tick(); refreshPanel();
    vscode.window.showInformationMessage('PeakGuard: provider removed.');
  }
 
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  bar.command = 'peakGuard.openPanel';
  bar.show();
 
  function tick(): void {
    try {
      const p = providers.find(x => x.id === activeId) ?? providers[0];
      if (!p) { bar.text = '○ PG · no provider'; bar.color = '#6b7280'; bar.tooltip = 'PeakGuard — add a provider to get started'; return; }
      const r = calcState(utcMin(new Date()), p);
      const { text, color } = barText(r, p, cfg.showPrice);
      bar.text    = text;
      bar.color   = color;
      bar.tooltip = buildTooltip(r, p, resolveZone(cfg.displayTimezone));
      refreshPanel();
    } catch (e) {
      console.error('PeakGuard: tick error', e);
      bar.text = '○ PG · error'; bar.color = '#6b7280';
    }
  }
 
  function openPanel(): void {
    const p = providers.find(x => x.id === activeId) ?? providers[0];
    if (!p) { vscode.window.showInformationMessage('PeakGuard: no provider configured.'); return; }
    if (panel) { panel.reveal(); return; }
 
    panel = vscode.window.createWebviewPanel(
      'peakGuard', 'PeakGuard',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [] }
    );
 
    const r = calcState(utcMin(new Date()), p);
    panel.webview.html = buildPanelHtml(r, p, providers, activeId, resolveZone(cfg.displayTimezone));
 
    panel.webview.onDidReceiveMessage(async msg => {
      switch (msg.command) {
        case 'switchProvider': await setActive(msg.id); refreshPanel(); break;
        case 'deleteProvider': await deleteProvider(msg.id); break;
        case 'addProvider':    await addProvider(); break;
        case 'refresh':        reload(); tick(); break;
      }
    }, null, ctx.subscriptions);
 
    panel.onDidDispose(() => { panel = undefined; }, null, ctx.subscriptions);
  }
 
  reload();
  tick();
 
  const interval = setInterval(tick, 60_000);
 
  ctx.subscriptions.push(
    bar,
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('peakGuard')) { reload(); tick(); }
    }),
    vscode.commands.registerCommand('peakGuard.openPanel',      openPanel),
    vscode.commands.registerCommand('peakGuard.openMenu',       openPanel),
    vscode.commands.registerCommand('peakGuard.switchProvider', openPanel),
    vscode.commands.registerCommand('peakGuard.addProvider',    () => addProvider()),
    vscode.commands.registerCommand('peakGuard.refresh',        () => { reload(); tick(); vscode.window.setStatusBarMessage('PeakGuard: refreshed', 2000); }),
    { dispose: () => clearInterval(interval) }
  );
}
 
export function deactivate(): void {}