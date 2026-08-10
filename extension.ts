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
  pricing: {
    offpeak: Pricing;
    peak: Pricing;
  };
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

// ─────────────────────────────────────────────
// SECTION 2 — PEAK ENGINE (pure functions)
// ─────────────────────────────────────────────

function timeStringToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function utcMinutes(now: Date): number {
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

function minutesUntilWindow(nowMin: number, windowStart: number): number {
  const diff = windowStart - nowMin;
  return diff > 0 ? diff : diff + 24 * 60;
}

function isInsideWindow(nowMin: number, start: number, end: number): boolean {
  if (start < end) {
    return nowMin >= start && nowMin < end;
  }
  return nowMin >= start || nowMin < end;
}

function calculateState(now: Date, provider: Provider): StateResult {
  const nowMin = utcMinutes(now);
  const warningMin = provider.warning_minutes ?? 20;

  for (const window of provider.peak_windows) {
    const start = timeStringToMinutes(window.start_utc);
    const end = timeStringToMinutes(window.end_utc);

    if (isInsideWindow(nowMin, start, end)) {
      const state: PeakState = provider.peak_pricing_active ? 'peak' : 'peak_announced';
      let minutesToEnd = end - nowMin;
      if (minutesToEnd <= 0) { minutesToEnd += 24 * 60; }
      return {
        state,
        minutesToNext: minutesToEnd,
        currentPricing: provider.peak_pricing_active
          ? provider.pricing.peak
          : provider.pricing.offpeak,
        activeWindow: window
      };
    }
  }

  let minDistance = Infinity;
  let nearestWindow: PeakWindow | null = null;
  for (const window of provider.peak_windows) {
    const start = timeStringToMinutes(window.start_utc);
    const dist = minutesUntilWindow(nowMin, start);
    if (dist < minDistance) { minDistance = dist; nearestWindow = window; }
  }

  const state: PeakState = minDistance <= warningMin ? 'approaching' : 'offpeak';
  return {
    state,
    minutesToNext: minDistance,
    currentPricing: provider.pricing.offpeak,
    activeWindow: nearestWindow
  };
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) { return `${Math.round(minutes)}m`; }
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatPrice(price: number): string {
  return `$${price.toFixed(price < 0.01 ? 4 : 2)}/M`;
}

function toLocalTimeString(utcTime: string, displayTimezone: string): string {
  try {
    const [h, m] = utcTime.split(':').map(Number);
    const date = new Date();
    date.setUTCHours(h, m, 0, 0);
    const tz = displayTimezone === 'auto'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : displayTimezone;
    return date.toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', timeZone: tz, timeZoneName: 'short'
    });
  } catch {
    return `${utcTime} UTC`;
  }
}

function getStatusBarText(
  result: StateResult,
  provider: Provider,
  showPrice: boolean
): { text: string; color: string } {
  const label = provider.shortLabel;
  const price = showPrice ? ` · ${formatPrice(result.currentPricing.input_miss)}` : '';
  switch (result.state) {
    case 'offpeak':
      return { text: `◉ ${label} · off-peak${price}`, color: '#34d399' };
    case 'approaching':
      return { text: `◑ ${label} · peak in ${formatMinutes(result.minutesToNext)}${price}`, color: '#fde047' };
    case 'peak':
      return { text: `⚡ ${label} · PEAK${price}`, color: '#f59e0b' };
    case 'peak_announced':
      return { text: `⏸ ${label} · peak window${price}`, color: '#f59e0b' };
  }
}

// ─────────────────────────────────────────────
// SECTION 3 — PROVIDER LOADING
// ─────────────────────────────────────────────

function loadBundledProviders(context: vscode.ExtensionContext): Provider[] {
  try {
    const filePath = path.join(context.extensionPath, 'providers.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw).providers as Provider[];
  } catch (err) {
    console.error('PeakGuard: failed to load bundled providers', err);
    return [];
  }
}

function loadUserProviders(): Provider[] {
  try {
    const config = vscode.workspace.getConfiguration('peakGuard');
    return config.get<Provider[]>('providers') ?? [];
  } catch (err) {
    console.error('PeakGuard: failed to load user providers', err);
    return [];
  }
}

function mergeProviders(bundled: Provider[], user: Provider[]): Provider[] {
  const map = new Map<string, Provider>();
  for (const p of bundled) { map.set(p.id, p); }
  for (const p of user) { map.set(p.id, { ...map.get(p.id), ...p } as Provider); }
  return Array.from(map.values());
}

function getActiveProvider(providers: Provider[], activeId: string): Provider | undefined {
  return providers.find(p => p.id === activeId) ?? providers[0];
}

// ─────────────────────────────────────────────
// SECTION 4 — TOOLTIP
// ─────────────────────────────────────────────

function buildTooltip(
  result: StateResult,
  provider: Provider,
  displayTimezone: string
): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.supportHtml = true;

  const stateLabel = {
    offpeak: '◉ Off-peak',
    approaching: `◑ Peak in ${formatMinutes(result.minutesToNext)}`,
    peak: '⚡ Peak active',
    peak_announced: '⏸ Peak window (surcharge not yet live)'
  }[result.state];

  md.appendMarkdown(`**PeakGuard** — ${provider.name}\n\n`);
  md.appendMarkdown(`**Status** ${stateLabel}\n\n`);
  md.appendMarkdown(`---\n\n`);
  md.appendMarkdown(`**Pricing**\n\n`);
  md.appendMarkdown(`| | Per 1M tokens |\n|---|---|\n`);
  md.appendMarkdown(`| Input (cache miss) | ${formatPrice(result.currentPricing.input_miss)} |\n`);
  md.appendMarkdown(`| Input (cache hit) | ${formatPrice(result.currentPricing.input_hit)} |\n`);
  md.appendMarkdown(`| Output | ${formatPrice(result.currentPricing.output)} |\n\n`);

  if (result.state === 'offpeak' || result.state === 'approaching') {
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`**Peak windows**\n\n`);
    for (const w of provider.peak_windows) {
      const localStart = toLocalTimeString(w.start_utc, displayTimezone);
      const localEnd = toLocalTimeString(w.end_utc, displayTimezone);
      md.appendMarkdown(`- ${w.start_utc}–${w.end_utc} UTC *(${localStart} – ${localEnd})*\n`);
    }
    md.appendMarkdown(`\n**Next peak** in ${formatMinutes(result.minutesToNext)}`);
    if (result.activeWindow) {
      md.appendMarkdown(` at ${toLocalTimeString(result.activeWindow.start_utc, displayTimezone)}`);
    }
    md.appendMarkdown(`\n\n`);
  }

  if (result.state === 'peak' || result.state === 'approaching') {
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`**Peak rate** ${formatPrice(provider.pricing.peak.input_miss)} *(2× normal)*\n\n`);
    md.appendMarkdown(`Off-peak again in ${formatMinutes(result.minutesToNext)}\n\n`);
  }

  if (provider.peak_pricing_announced && !provider.peak_pricing_active) {
    md.appendMarkdown(`---\n\n⚠ Surcharge **announced** — not yet live\n\n`);
  }

  md.appendMarkdown(`---\n\n`);
  md.appendMarkdown(`$(symbol-color) Click for details  $(chevron-right)  Right-click for menu`);

  return md;
}

// ─────────────────────────────────────────────
// SECTION 5 — PANEL WEBVIEW
// ─────────────────────────────────────────────

function buildPanelHtml(
  result: StateResult,
  provider: Provider,
  providers: Provider[],
  activeId: string,
  displayTimezone: string
): string {
  const stateColor = {
    offpeak: '#34d399',
    approaching: '#fde047',
    peak: '#f59e0b',
    peak_announced: '#f59e0b'
  }[result.state];

  const stateLabel = {
    offpeak: '◉ Off-peak',
    approaching: `◑ Peak in ${formatMinutes(result.minutesToNext)}`,
    peak: '⚡ PEAK active',
    peak_announced: '⏸ Peak window'
  }[result.state];

  const suggestion = {
    offpeak: `Good time to run Composer. Next peak in ${formatMinutes(result.minutesToNext)}.`,
    approaching: `Finish your session soon — peak starts in ${formatMinutes(result.minutesToNext)}.`,
    peak: `Peak hours active. Switch provider or wait for off-peak.`,
    peak_announced: `Peak window active. Surcharge not yet live — monitor pricing page.`
  }[result.state];

  const windowsHtml = provider.peak_windows.map(w => {
    const localStart = toLocalTimeString(w.start_utc, displayTimezone);
    const localEnd = toLocalTimeString(w.end_utc, displayTimezone);
    return `<div class="row">
      <span class="label">${w.start_utc}–${w.end_utc} UTC</span>
      <span class="value dim">${localStart} – ${localEnd}</span>
    </div>`;
  }).join('');

  // bundled provider IDs — these cannot be deleted, only switched away from
  const bundledIds = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);

  const providerRows = providers.map(p => {
    const r = calculateState(new Date(), p);
    const dot = { offpeak: '#34d399', approaching: '#fde047', peak: '#f59e0b', peak_announced: '#f59e0b' }[r.state];
    const stateText = {
      offpeak: 'off-peak',
      approaching: `peak in ${formatMinutes(r.minutesToNext)}`,
      peak: 'PEAK',
      peak_announced: 'peak window'
    }[r.state];
    const isActive = p.id === activeId;
    const isBundled = bundledIds.has(p.id);
    const deleteBtn = !isBundled
      ? `<button class="delete-btn" onclick="event.stopPropagation(); deleteProvider('${p.id}')" title="Remove provider">✕</button>`
      : '';
    return `<div class="provider-row ${isActive ? 'active' : ''}" onclick="switchProvider('${p.id}')">
      <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
        <div style="width:7px;height:7px;border-radius:50%;background:${dot};flex-shrink:0;"></div>
        <div style="min-width:0;">
          <div class="provider-name">${p.name}${isActive ? ' <span class="active-badge">active</span>' : ''}${isBundled ? ' <span class="bundled-badge">built-in</span>' : ''}</div>
          <div class="provider-sub">${p.model}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
        <span class="provider-state" style="color:${dot};">${stateText}</span>
        ${deleteBtn}
      </div>
    </div>`;
  }).join('');

  const isWarn = result.state === 'peak' || result.state === 'approaching';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>PeakGuard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 12px; color: #e2e8f0; background: #1a1a2e; line-height: 1.5;
  }
  .header {
    padding: 12px 16px 10px;
    border-bottom: 0.5px solid #2a2a3e;
    display: flex; justify-content: space-between; align-items: center;
  }
  .header-title { font-size: 13px; font-weight: 500; color: #e2e8f0; }
  .header-state { font-size: 11px; color: ${stateColor}; font-family: monospace; }
  .section { padding: 10px 16px; border-bottom: 0.5px solid #1e1e2e; }
  .section-label {
    font-size: 10px; letter-spacing: 0.07em; text-transform: uppercase;
    color: #4a4a6a; margin-bottom: 8px; font-weight: 500;
  }
  .row { display: flex; justify-content: space-between; align-items: baseline; padding: 2px 0; }
  .label { font-size: 11px; color: #6b7280; }
  .value { font-size: 11px; color: #e2e8f0; font-family: monospace; }
  .value.green { color: #34d399; }
  .value.amber { color: #f59e0b; }
  .value.dim { color: #6b7280; }
  .divider { border: none; border-top: 0.5px solid #2a2a3e; margin: 4px 0; }
  .suggestion {
    margin: 10px 16px;
    background: ${isWarn ? 'rgba(245,158,11,0.06)' : 'rgba(52,211,153,0.06)'};
    border-radius: 8px; padding: 8px 10px;
    border: 0.5px solid ${isWarn ? 'rgba(245,158,11,0.12)' : 'rgba(52,211,153,0.12)'};
  }
  .sug-title { font-size: 10px; color: ${isWarn ? '#f59e0b' : '#34d399'}; font-weight: 500; margin-bottom: 2px; }
  .sug-body { font-size: 10px; color: ${isWarn ? '#9a7a4a' : '#4a9a78'}; line-height: 1.5; }
  .notice {
    margin: 0 16px 8px; padding: 6px 10px;
    background: rgba(245,158,11,0.06);
    border: 0.5px solid rgba(245,158,11,0.12);
    border-radius: 6px; font-size: 10px; color: #f59e0b;
  }

  /* Provider rows */
  .provider-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 7px 8px; border-radius: 6px; cursor: pointer;
    margin-bottom: 2px; transition: background 0.1s;
  }
  .provider-row:hover { background: rgba(255,255,255,0.04); }
  .provider-row.active { background: rgba(52,211,153,0.06); border: 0.5px solid rgba(52,211,153,0.12); }
  .provider-name { font-size: 11px; color: #e2e8f0; }
  .provider-sub { font-size: 10px; color: #6b7280; margin-top: 1px; }
  .provider-state { font-size: 10px; font-family: monospace; }
  .active-badge {
    font-size: 9px; background: rgba(52,211,153,0.15); color: #34d399;
    padding: 1px 5px; border-radius: 3px; margin-left: 4px;
  }
  .bundled-badge {
    font-size: 9px; background: rgba(107,114,128,0.2); color: #6b7280;
    padding: 1px 5px; border-radius: 3px; margin-left: 4px;
  }
  .delete-btn {
    background: none; border: none;
    color: #4a4a6a; font-size: 11px;
    cursor: pointer; padding: 2px 5px; border-radius: 4px;
    transition: color 0.15s, background 0.15s;
    line-height: 1;
  }
  .delete-btn:hover { color: #f87171; background: rgba(248,113,113,0.1); }

  /* Action buttons */
  .actions { padding: 10px 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  .btn {
    flex: 1; min-width: 80px;
    background: rgba(255,255,255,0.05);
    border: 0.5px solid #2a2a3e;
    border-radius: 6px; padding: 7px 10px;
    font-size: 11px; color: #e2e8f0;
    cursor: pointer; text-align: center;
    transition: background 0.15s, border-color 0.15s;
  }
  .btn:hover { background: rgba(255,255,255,0.09); border-color: #3a3a4e; }
  .btn.primary {
    background: rgba(52,211,153,0.1);
    border-color: rgba(52,211,153,0.25);
    color: #34d399;
  }
  .btn.primary:hover { background: rgba(52,211,153,0.16); }
</style>
</head>
<body>

  <div class="header">
    <span class="header-title">PeakGuard</span>
    <span class="header-state">${stateLabel}</span>
  </div>

  <div class="section">
    <div class="section-label">Current pricing — ${provider.name}</div>
    <div class="row">
      <span class="label">Input (cache miss)</span>
      <span class="value ${result.state === 'peak' ? 'amber' : 'green'}">${formatPrice(result.currentPricing.input_miss)}</span>
    </div>
    <div class="row">
      <span class="label">Input (cache hit)</span>
      <span class="value green">${formatPrice(result.currentPricing.input_hit)}</span>
    </div>
    <div class="row">
      <span class="label">Output</span>
      <span class="value dim">${formatPrice(result.currentPricing.output)}</span>
    </div>
    ${result.state === 'offpeak' || result.state === 'approaching' ? `
    <hr class="divider" style="margin-top:6px;">
    <div class="row" style="margin-top:4px;">
      <span class="label">Peak input (2×)</span>
      <span class="value dim">${formatPrice(provider.pricing.peak.input_miss)}</span>
    </div>` : ''}
  </div>

  <div class="section">
    <div class="section-label">Peak windows (your time)</div>
    ${windowsHtml}
    <hr class="divider" style="margin-top:4px;">
    <div class="row" style="margin-top:4px;">
      <span class="label">${result.state === 'peak' || result.state === 'peak_announced' ? 'Off-peak in' : 'Next peak in'}</span>
      <span class="value ${result.state === 'peak' || result.state === 'peak_announced' ? 'green' : 'amber'}">${formatMinutes(result.minutesToNext)}</span>
    </div>
  </div>

  <div class="suggestion">
    <div class="sug-title">${isWarn ? 'Heads up' : 'Good time to run'}</div>
    <div class="sug-body">${suggestion}</div>
  </div>

  ${provider.peak_pricing_announced && !provider.peak_pricing_active ? `
  <div class="notice">⚠ Surcharge announced — not yet live</div>` : ''}

  <div class="section">
    <div class="section-label">Providers</div>
    ${providerRows}
  </div>

  <div class="actions">
    <button class="btn primary" onclick="addProvider()">＋ Add Provider</button>
    <button class="btn" onclick="refresh()">↻ Refresh</button>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  function switchProvider(id) { vscode.postMessage({ command: 'switchProvider', id }); }
  function addProvider() { vscode.postMessage({ command: 'addProvider' }); }
  function refresh() { vscode.postMessage({ command: 'refresh' }); }
  function deleteProvider(id) { vscode.postMessage({ command: 'deleteProvider', id }); }
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────
// SECTION 6 — ADD PROVIDER FLOW
// ─────────────────────────────────────────────

async function runAddProviderFlow(): Promise<void> {
  // name
  const name = await vscode.window.showInputBox({
    title: 'Add Provider (1/9)',
    prompt: 'Provider display name',
    placeHolder: 'e.g. Kimi K2.6'
  });
  if (!name) { return; }
 
  // off-peak rates
  const offMiss = await vscode.window.showInputBox({
    title: 'Add Provider (2/9) — Off-peak pricing',
    prompt: 'Input · Cache Miss price per 1M tokens (USD)',
    placeHolder: 'e.g. 0.14',
    validateInput: v => isNaN(Number(v)) ? 'Enter a number' : null
  });
  if (offMiss === undefined) { return; }
 
  const offHit = await vscode.window.showInputBox({
    title: 'Add Provider (3/9) — Off-peak pricing',
    prompt: 'Input · Cache Hit price per 1M tokens (USD)',
    placeHolder: 'e.g. 0.0028',
    validateInput: v => isNaN(Number(v)) ? 'Enter a number' : null
  });
  if (offHit === undefined) { return; }
 
  const offOutput = await vscode.window.showInputBox({
    title: 'Add Provider (4/9) — Off-peak pricing',
    prompt: 'Output · Generated price per 1M tokens (USD)',
    placeHolder: 'e.g. 0.28',
    validateInput: v => isNaN(Number(v)) ? 'Enter a number' : null
  });
  if (offOutput === undefined) { return; }
 
  // peak rates
  const pkMiss = await vscode.window.showInputBox({
    title: 'Add Provider (5/9) — Peak pricing',
    prompt: 'Input · Cache Miss price per 1M tokens (USD) — enter 0 if no peak surcharge',
    placeHolder: 'e.g. 0.28',
    validateInput: v => isNaN(Number(v)) ? 'Enter a number' : null
  });
  if (pkMiss === undefined) { return; }
 
  const pkHit = await vscode.window.showInputBox({
    title: 'Add Provider (6/9) — Peak pricing',
    prompt: 'Input · Cache Hit price per 1M tokens (USD)',
    placeHolder: 'e.g. 0.0056',
    value: Number(pkMiss) > 0 ? '' : '0',
    validateInput: v => isNaN(Number(v)) ? 'Enter a number' : null
  });
  if (pkHit === undefined) { return; }
 
  const pkOutput = await vscode.window.showInputBox({
    title: 'Add Provider (7/9) — Peak pricing',
    prompt: 'Output · Generated price per 1M tokens (USD)',
    placeHolder: 'e.g. 0.56',
    value: Number(pkMiss) > 0 ? '' : '0',
    validateInput: v => isNaN(Number(v)) ? 'Enter a number' : null
  });
  if (pkOutput === undefined) { return; }
 
  // timezone + peak hours
  const timezone = await vscode.window.showInputBox({
    title: 'Add Provider (8/9) — Peak hours',
    prompt: 'Timezone for peak windows',
    placeHolder: 'e.g. Asia/Shanghai',
    value: Intl.DateTimeFormat().resolvedOptions().timeZone
  });
  if (!timezone) { return; }
 
  const windows = await vscode.window.showInputBox({
    title: 'Add Provider (9/9) — Peak hours',
    prompt: 'Peak windows in UTC — comma separated (HH:MM-HH:MM), blank if none',
    placeHolder: 'e.g. 01:00-04:00, 06:00-10:00'
  });
  if (windows === undefined) { return; }
 
  const parsedWindows: PeakWindow[] = (windows ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(s => {
      const [start, end] = s.split('-').map(t => t.trim());
      return { start_utc: start, end_utc: end };
    })
    .filter(w => w.start_utc && w.end_utc);
 
  const hasPeak = Number(pkMiss) > 0;
  const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
 
  const newProvider: Provider = {
    id, name, model: id,
    shortLabel: name.split(' ')[0],
    timezone,
    peak_pricing_active: hasPeak,
    peak_pricing_announced: false,
    pricing: {
      offpeak: {
        input_miss: Number(offMiss),
        input_hit:  Number(offHit),
        output:     Number(offOutput)
      },
      peak: {
        input_miss: Number(pkMiss),
        input_hit:  Number(pkHit),
        output:     Number(pkOutput)
      }
    },
    peak_windows: parsedWindows,
    warning_minutes: 20,
    source: '',
    last_verified: new Date().toISOString().split('T')[0]
  };
 
  const config = vscode.workspace.getConfiguration('peakGuard');
  const existing = config.get<Provider[]>('providers') ?? [];
  await config.update('providers', [...existing, newProvider], vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`PeakGuard: ${name} added.`);
}

// ─────────────────────────────────────────────
// SECTION 7 — ACTIVATE
// ─────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  let providers: Provider[] = [];
  let activeProviderId: string = '';
  let panel: vscode.WebviewPanel | undefined;

  function reloadConfig(): void {
    const bundled = loadBundledProviders(context);
    const user = loadUserProviders();
    providers = mergeProviders(bundled, user);
    const config = vscode.workspace.getConfiguration('peakGuard');
    const savedId = config.get<string>('activeProvider') ?? '';
    activeProviderId = providers.find(p => p.id === savedId)
      ? savedId
      : (providers[0]?.id ?? '');
  }

  function getDisplayTimezone(): string {
    return vscode.workspace.getConfiguration('peakGuard').get<string>('displayTimezone') ?? 'auto';
  }

  function getShowPrice(): boolean {
    return vscode.workspace.getConfiguration('peakGuard').get<boolean>('showPrice') ?? true;
  }

  // status bar item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'peakGuard.openPanel';
  statusBarItem.show();

  function refreshPanel(): void {
    if (!panel) { return; }
    const provider = getActiveProvider(providers, activeProviderId);
    if (!provider) { return; }
    const result = calculateState(new Date(), provider);
    panel.webview.html = buildPanelHtml(result, provider, providers, activeProviderId, getDisplayTimezone());
  }

  function tick(): void {
    try {
      const provider = getActiveProvider(providers, activeProviderId);
      if (!provider) {
        statusBarItem.text = '○ PG · no provider';
        statusBarItem.color = '#6b7280';
        statusBarItem.tooltip = 'PeakGuard — no provider configured';
        return;
      }
      const now = new Date();
      const result = calculateState(now, provider);
      const { text, color } = getStatusBarText(result, provider, getShowPrice());
      statusBarItem.text = text;
      statusBarItem.color = color;
      statusBarItem.tooltip = buildTooltip(result, provider, getDisplayTimezone());
      refreshPanel();
    } catch (err) {
      console.error('PeakGuard: tick error', err);
      statusBarItem.text = '○ PG · error';
      statusBarItem.color = '#6b7280';
    }
  }

  reloadConfig();
  tick();
  const interval = setInterval(tick, 60 * 1000);

  const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('peakGuard')) { reloadConfig(); tick(); }
  });

  // ── Open Panel (click on status bar) ──
  const cmdOpenPanel = vscode.commands.registerCommand('peakGuard.openPanel', () => {
    const provider = getActiveProvider(providers, activeProviderId);
    if (!provider) {
      vscode.window.showInformationMessage('PeakGuard: no provider configured');
      return;
    }
    if (panel) { panel.reveal(); return; }

    panel = vscode.window.createWebviewPanel(
      'peakGuard', 'PeakGuard',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: false }
    );

    refreshPanel();

    // handle messages from webview buttons
    panel.webview.onDidReceiveMessage(async msg => {
      switch (msg.command) {
        case 'switchProvider': {
          activeProviderId = msg.id;
          await vscode.workspace.getConfiguration('peakGuard')
            .update('activeProvider', msg.id, vscode.ConfigurationTarget.Global);
          tick();
          break;
        }
        case 'addProvider': {
          await runAddProviderFlow();
          reloadConfig();
          tick();
          break;
        }
        case 'refresh': {
          reloadConfig();
          tick();
          break;
        }
        case 'deleteProvider': {
          const config = vscode.workspace.getConfiguration('peakGuard');
          const userProviders = config.get<Provider[]>('providers') ?? [];
          const updated = userProviders.filter(p => p.id !== msg.id);
          await config.update('providers', updated, vscode.ConfigurationTarget.Global);
          // if deleted provider was active, switch to first available
          if (activeProviderId === msg.id) {
            reloadConfig();
            activeProviderId = providers[0]?.id ?? '';
            await config.update('activeProvider', activeProviderId, vscode.ConfigurationTarget.Global);
          } else {
            reloadConfig();
          }
          tick();
          vscode.window.showInformationMessage(`PeakGuard: provider removed.`);
          break;
        }
      }
    }, null, context.subscriptions);

    panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
  });

  // ── Right-click menu on status bar ──
  const cmdMenu = vscode.commands.registerCommand('peakGuard.showMenu', async () => {
    const now = new Date();
    const items = [
      ...providers.map(p => {
        const r = calculateState(now, p);
        const icon = { offpeak: '◉', approaching: '◑', peak: '⚡', peak_announced: '⏸' }[r.state];
        const stateText = {
          offpeak: 'off-peak',
          approaching: `peak in ${formatMinutes(r.minutesToNext)}`,
          peak: 'PEAK',
          peak_announced: 'peak window'
        }[r.state];
        return {
          label: `${p.id === activeProviderId ? '● ' : '  '}${p.name}`,
          description: `${icon} ${stateText} · ${formatPrice(r.currentPricing.input_miss)}`,
          kind: vscode.QuickPickItemKind.Default,
          action: 'switch',
          providerId: p.id
        };
      }),
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: '', providerId: '' },
      { label: '$(add) Add Provider', description: 'Configure a new API provider', kind: vscode.QuickPickItemKind.Default, action: 'add', providerId: '' },
      { label: '$(refresh) Refresh', description: 'Reload config and state', kind: vscode.QuickPickItemKind.Default, action: 'refresh', providerId: '' },
      { label: '$(gear) Settings', description: 'Open PeakGuard settings', kind: vscode.QuickPickItemKind.Default, action: 'settings', providerId: '' },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: 'PeakGuard',
      placeHolder: 'Switch provider or manage settings'
    });

    if (!picked) { return; }

    switch (picked.action) {
      case 'switch': {
        activeProviderId = picked.providerId;
        await vscode.workspace.getConfiguration('peakGuard')
          .update('activeProvider', picked.providerId, vscode.ConfigurationTarget.Global);
        tick();
        vscode.window.setStatusBarMessage(
          `PeakGuard: switched to ${providers.find(p => p.id === picked.providerId)?.name}`, 3000
        );
        break;
      }
      case 'add': {
        await runAddProviderFlow();
        reloadConfig();
        tick();
        break;
      }
      case 'refresh': {
        reloadConfig();
        tick();
        vscode.window.setStatusBarMessage('PeakGuard: refreshed', 2000);
        break;
      }
      case 'settings': {
        vscode.commands.executeCommand('workbench.action.openSettings', 'peakGuard');
        break;
      }
    }
  });

  // ── Other commands ──
  const cmdSwitch = vscode.commands.registerCommand('peakGuard.switchProvider', () =>
    vscode.commands.executeCommand('peakGuard.showMenu')
  );

  const cmdAdd = vscode.commands.registerCommand('peakGuard.addProvider', async () => {
    await runAddProviderFlow();
    reloadConfig();
    tick();
  });

  const cmdRefresh = vscode.commands.registerCommand('peakGuard.refresh', () => {
    reloadConfig();
    tick();
    vscode.window.setStatusBarMessage('PeakGuard: refreshed', 2000);
  });

  context.subscriptions.push(
    statusBarItem,
    configWatcher,
    cmdOpenPanel,
    cmdMenu,
    cmdSwitch,
    cmdAdd,
    cmdRefresh,
    { dispose: () => clearInterval(interval) }
  );
}

export function deactivate(): void {}
