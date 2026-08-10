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
// All functions accept time as a parameter —
// never call new Date() internally.
// This makes every function fully testable.
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
  // handle midnight rollover
  return diff > 0 ? diff : diff + 24 * 60;
}

function isInsideWindow(nowMin: number, start: number, end: number): boolean {
  if (start < end) {
    return nowMin >= start && nowMin < end;
  }
  // window crosses midnight
  return nowMin >= start || nowMin < end;
}

function calculateState(now: Date, provider: Provider): StateResult {
  const nowMin = utcMinutes(now);
  const warningMin = provider.warning_minutes ?? 20;

  // check if currently inside any peak window
  for (const window of provider.peak_windows) {
    const start = timeStringToMinutes(window.start_utc);
    const end = timeStringToMinutes(window.end_utc);

    if (isInsideWindow(nowMin, start, end)) {
      const state: PeakState = provider.peak_pricing_active
        ? 'peak'
        : 'peak_announced';

      // minutes until this window ends
      let minutesToEnd = end - nowMin;
      if (minutesToEnd <= 0) {
        minutesToEnd += 24 * 60;
      }

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

  // not in a peak window — find nearest upcoming window
  let minDistance = Infinity;
  let nearestWindow: PeakWindow | null = null;

  for (const window of provider.peak_windows) {
    const start = timeStringToMinutes(window.start_utc);
    const dist = minutesUntilWindow(nowMin, start);
    if (dist < minDistance) {
      minDistance = dist;
      nearestWindow = window;
    }
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
  if (minutes < 60) {
    return `${Math.round(minutes)}m`;
  }
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
      hour: '2-digit',
      minute: '2-digit',
      timeZone: tz,
      timeZoneName: 'short'
    });
  } catch {
    return `${utcTime} UTC`;
  }
}

function getStatusBarText(
  result: StateResult,
  provider: Provider,
  showPrice: boolean
): { text: string; color: string; tooltip: string } {
  const label = provider.shortLabel;
  const price = showPrice ? ` · ${formatPrice(result.currentPricing.input_miss)}` : '';

  switch (result.state) {
    case 'offpeak':
      return {
        text: `◉ ${label} · off-peak${price}`,
        color: '#34d399',
        tooltip: 'Off-peak — good time to run Composer sessions'
      };
    case 'approaching':
      return {
        text: `◑ ${label} · peak in ${formatMinutes(result.minutesToNext)}${price}`,
        color: '#fde047',
        tooltip: `Peak approaching in ${formatMinutes(result.minutesToNext)}`
      };
    case 'peak':
      return {
        text: `⚡ ${label} · PEAK${price}`,
        color: '#f59e0b',
        tooltip: 'Peak hours — costs 2× normal rate'
      };
    case 'peak_announced':
      return {
        text: `⏸ ${label} · peak window${price}`,
        color: '#f59e0b',
        tooltip: 'Peak window active — surcharge announced but not yet live'
      };
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
    const userProviders = config.get<Provider[]>('providers') ?? [];
    return userProviders;
  } catch (err) {
    console.error('PeakGuard: failed to load user providers', err);
    return [];
  }
}

function mergeProviders(bundled: Provider[], user: Provider[]): Provider[] {
  const map = new Map<string, Provider>();
  // bundled first, user overrides by id
  for (const p of bundled) {
    map.set(p.id, p);
  }
  for (const p of user) {
    map.set(p.id, { ...map.get(p.id), ...p } as Provider);
  }
  return Array.from(map.values());
}

function getActiveProvider(
  providers: Provider[],
  activeId: string
): Provider | undefined {
  return providers.find(p => p.id === activeId) ?? providers[0];
}

// ─────────────────────────────────────────────
// SECTION 4 — TOOLTIP CONTENT
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
    md.appendMarkdown(`**Peak windows (Beijing time)**\n\n`);
    for (const w of provider.peak_windows) {
      const localStart = toLocalTimeString(w.start_utc, displayTimezone);
      const localEnd = toLocalTimeString(w.end_utc, displayTimezone);
      md.appendMarkdown(`- ${w.start_utc}–${w.end_utc} UTC *(${localStart} – ${localEnd})*\n`);
    }
    md.appendMarkdown(`\n`);
    md.appendMarkdown(`**Next peak** in ${formatMinutes(result.minutesToNext)}`);
    if (result.activeWindow) {
      const localStart = toLocalTimeString(result.activeWindow.start_utc, displayTimezone);
      md.appendMarkdown(` at ${localStart}`);
    }
    md.appendMarkdown(`\n\n`);
  }

  if (result.state === 'peak' || result.state === 'approaching') {
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`**Peak pricing** ${formatPrice(provider.pricing.peak.input_miss)} input `);
    md.appendMarkdown(`*(2× normal)*\n\n`);
    md.appendMarkdown(`Off-peak again in ${formatMinutes(result.minutesToNext)}\n\n`);
  }

  if (provider.peak_pricing_announced && !provider.peak_pricing_active) {
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`⚠ 2× surcharge **announced** — not yet live\n\n`);
  }

  if (result.state === 'offpeak') {
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`✅ Good time to run heavy Composer sessions`);
  } else if (result.state === 'approaching') {
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`⚡ Finish your session or switch provider before peak`);
  }

  return md;
}

// ─────────────────────────────────────────────
// SECTION 5 — PANEL (webview)
// ─────────────────────────────────────────────

function buildPanelHtml(
  result: StateResult,
  provider: Provider,
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
    peak_announced: `Peak window active. Surcharge not yet live — monitor DeepSeek pricing page.`
  }[result.state];

  const windowsHtml = provider.peak_windows.map(w => {
    const localStart = toLocalTimeString(w.start_utc, displayTimezone);
    const localEnd = toLocalTimeString(w.end_utc, displayTimezone);
    return `
      <div class="row">
        <span class="label">${w.start_utc}–${w.end_utc} UTC</span>
        <span class="value dim">${localStart} – ${localEnd}</span>
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>PeakGuard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 12px;
    color: #e2e8f0;
    background: #1a1a2e;
    padding: 0;
    line-height: 1.5;
  }
  .header {
    padding: 12px 16px 10px;
    border-bottom: 0.5px solid #2a2a3e;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .header-title { font-size: 13px; font-weight: 500; color: #e2e8f0; }
  .header-state { font-size: 11px; color: ${stateColor}; font-family: monospace; }
  .section { padding: 10px 16px; border-bottom: 0.5px solid #1e1e2e; }
  .section-label {
    font-size: 10px;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: #4a4a6a;
    margin-bottom: 8px;
    font-weight: 500;
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 2px 0;
  }
  .label { font-size: 11px; color: #6b7280; }
  .value { font-size: 11px; color: #e2e8f0; font-family: monospace; }
  .value.green { color: #34d399; }
  .value.amber { color: #f59e0b; }
  .value.yellow { color: #fde047; }
  .value.dim { color: #6b7280; }
  .suggestion {
    margin: 10px 16px;
    background: rgba(52,211,153,0.06);
    border-radius: 8px;
    padding: 8px 10px;
    border: 0.5px solid rgba(52,211,153,0.12);
  }
  .suggestion.warn {
    background: rgba(245,158,11,0.06);
    border-color: rgba(245,158,11,0.12);
  }
  .sug-title { font-size: 10px; color: #34d399; font-weight: 500; margin-bottom: 2px; }
  .sug-title.warn { color: #f59e0b; }
  .sug-body { font-size: 10px; color: #4a9a78; line-height: 1.5; }
  .sug-body.warn { color: #9a7a4a; }
  .notice {
    margin: 8px 16px 10px;
    padding: 6px 10px;
    background: rgba(245,158,11,0.06);
    border: 0.5px solid rgba(245,158,11,0.12);
    border-radius: 6px;
    font-size: 10px;
    color: #f59e0b;
  }
  .divider { border: none; border-top: 0.5px solid #2a2a3e; margin: 2px 0; }
</style>
</head>
<body>
  <div class="header">
    <span class="header-title">PeakGuard</span>
    <span class="header-state">${stateLabel}</span>
  </div>

  <div class="section">
    <div class="section-label">Current pricing</div>
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
      <span class="label">Peak input</span>
      <span class="value dim">${formatPrice(provider.pricing.peak.input_miss)} (2×)</span>
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

  <div class="suggestion ${result.state === 'peak' || result.state === 'approaching' ? 'warn' : ''}">
    <div class="sug-title ${result.state === 'peak' || result.state === 'approaching' ? 'warn' : ''}">
      ${result.state === 'offpeak' ? 'Good time to run Composer' :
        result.state === 'approaching' ? 'Heads up' :
        result.state === 'peak' ? 'Peak hours active' : 'Peak window'}
    </div>
    <div class="sug-body ${result.state === 'peak' || result.state === 'approaching' ? 'warn' : ''}">${suggestion}</div>
  </div>

  ${provider.peak_pricing_announced && !provider.peak_pricing_active ? `
  <div class="notice">⚠ 2× surcharge announced — not yet live. Monitor <a href="${provider.source}" style="color:#f59e0b;">DeepSeek pricing page</a>.</div>
  ` : ''}
</body>
</html>`;
}

// ─────────────────────────────────────────────
// SECTION 6 — COMMANDS
// ─────────────────────────────────────────────

async function switchProviderCommand(
  providers: Provider[],
  getActiveId: () => string,
  setActiveId: (id: string) => void
): Promise<void> {
  const now = new Date();

  const items = providers.map(p => {
    const result = calculateState(now, p);
    const stateIcon = {
      offpeak: '◉',
      approaching: '◑',
      peak: '⚡',
      peak_announced: '⏸'
    }[result.state];
    const stateLabel = {
      offpeak: 'off-peak',
      approaching: `peak in ${formatMinutes(result.minutesToNext)}`,
      peak: 'PEAK',
      peak_announced: 'peak window'
    }[result.state];

    return {
      label: `${p.id === getActiveId() ? '● ' : '  '}${p.name}`,
      description: `${stateIcon} ${stateLabel} · ${formatPrice(result.currentPricing.input_miss)}`,
      detail: `Model: ${p.model}`,
      providerId: p.id
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select active provider',
    title: 'PeakGuard — Switch Provider'
  });

  if (picked) {
    setActiveId(picked.providerId);
    await vscode.workspace
      .getConfiguration('peakGuard')
      .update('activeProvider', picked.providerId, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(
      `PeakGuard: switched to ${providers.find(p => p.id === picked.providerId)?.name}`,
      3000
    );
  }
}

async function addProviderCommand(): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Add Provider (1/5)',
    prompt: 'Provider display name',
    placeHolder: 'e.g. Groq Llama-70B'
  });
  if (!name) { return; }

  const offpeakPrice = await vscode.window.showInputBox({
    title: 'Add Provider (2/5)',
    prompt: 'Off-peak input price per 1M tokens (USD)',
    placeHolder: 'e.g. 0.00',
    validateInput: v => isNaN(Number(v)) ? 'Enter a number' : null
  });
  if (offpeakPrice === undefined) { return; }

  const peakPrice = await vscode.window.showInputBox({
    title: 'Add Provider (3/5)',
    prompt: 'Peak input price per 1M tokens (USD) — enter 0 if no peak pricing',
    placeHolder: 'e.g. 0.00',
    validateInput: v => isNaN(Number(v)) ? 'Enter a number' : null
  });
  if (peakPrice === undefined) { return; }

  const timezone = await vscode.window.showInputBox({
    title: 'Add Provider (4/5)',
    prompt: 'Timezone for peak windows',
    placeHolder: 'e.g. America/Chicago',
    value: Intl.DateTimeFormat().resolvedOptions().timeZone
  });
  if (!timezone) { return; }

  const windows = await vscode.window.showInputBox({
    title: 'Add Provider (5/5)',
    prompt: 'Peak windows in UTC — comma separated pairs (HH:MM-HH:MM), or leave blank for none',
    placeHolder: 'e.g. 01:00-04:00, 06:00-10:00'
  });
  if (windows === undefined) { return; }

  const parsedWindows: PeakWindow[] = (windows ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const [start, end] = s.split('-').map(t => t.trim());
      return { start_utc: start, end_utc: end };
    })
    .filter(w => w.start_utc && w.end_utc);

  const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const offpeak = Number(offpeakPrice);
  const peak = Number(peakPrice);

  const newProvider: Provider = {
    id,
    name,
    model: id,
    shortLabel: name.split(' ')[0],
    timezone,
    peak_pricing_active: peak > 0,
    peak_pricing_announced: false,
    pricing: {
      offpeak: { input_miss: offpeak, input_hit: offpeak * 0.02, output: offpeak * 2 },
      peak: { input_miss: peak, input_hit: peak * 0.02, output: peak * 2 }
    },
    peak_windows: parsedWindows,
    warning_minutes: 20,
    source: '',
    last_verified: new Date().toISOString().split('T')[0]
  };

  const config = vscode.workspace.getConfiguration('peakGuard');
  const existing = config.get<Provider[]>('providers') ?? [];
  await config.update(
    'providers',
    [...existing, newProvider],
    vscode.ConfigurationTarget.Global
  );

  vscode.window.showInformationMessage(
    `PeakGuard: ${name} added. Switch to it with > PeakGuard: Switch Provider`
  );
}

// ─────────────────────────────────────────────
// SECTION 7 — ACTIVATE
// ─────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // state
  let providers: Provider[] = [];
  let activeProviderId: string = '';
  let panel: vscode.WebviewPanel | undefined;

  // load config
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
    return vscode.workspace
      .getConfiguration('peakGuard')
      .get<string>('displayTimezone') ?? 'auto';
  }

  function getShowPrice(): boolean {
    return vscode.workspace
      .getConfiguration('peakGuard')
      .get<boolean>('showPrice') ?? true;
  }

  // status bar item
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'peakGuard.openPanel';
  statusBarItem.show();

  // tick — updates every 60 seconds
  function tick(): void {
    try {
      const provider = getActiveProvider(providers, activeProviderId);
      if (!provider) {
        statusBarItem.text = '○ DS · no provider';
        statusBarItem.color = '#6b7280';
        statusBarItem.tooltip = 'PeakGuard — no provider configured';
        return;
      }

      const now = new Date();
      const result = calculateState(now, provider);
      const { text, color, tooltip } = getStatusBarText(result, provider, getShowPrice());

      statusBarItem.text = text;
      statusBarItem.color = color;
      statusBarItem.tooltip = buildTooltip(result, provider, getDisplayTimezone());

      // refresh panel if open
      if (panel) {
        panel.webview.html = buildPanelHtml(result, provider, getDisplayTimezone());
      }
    } catch (err) {
      console.error('PeakGuard: tick error', err);
      statusBarItem.text = '○ DS · error';
      statusBarItem.color = '#6b7280';
    }
  }

  // initial load
  reloadConfig();
  tick();

  // 60-second interval
  const interval = setInterval(tick, 60 * 1000);

  // reload config on settings change
  const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('peakGuard')) {
      reloadConfig();
      tick();
    }
  });

  // commands
  const cmdOpenPanel = vscode.commands.registerCommand(
    'peakGuard.openPanel',
    () => {
      const provider = getActiveProvider(providers, activeProviderId);
      if (!provider) {
        vscode.window.showInformationMessage('PeakGuard: no provider configured');
        return;
      }

      if (panel) {
        panel.reveal();
        return;
      }

      panel = vscode.window.createWebviewPanel(
        'peakGuard',
        'PeakGuard',
        vscode.ViewColumn.Beside,
        { enableScripts: false, retainContextWhenHidden: false }
      );

      const result = calculateState(new Date(), provider);
      panel.webview.html = buildPanelHtml(result, provider, getDisplayTimezone());

      panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
    }
  );

  const cmdSwitch = vscode.commands.registerCommand(
    'peakGuard.switchProvider',
    () => switchProviderCommand(
      providers,
      () => activeProviderId,
      (id) => { activeProviderId = id; tick(); }
    )
  );

  const cmdAdd = vscode.commands.registerCommand(
    'peakGuard.addProvider',
    addProviderCommand
  );

  const cmdRefresh = vscode.commands.registerCommand(
    'peakGuard.refresh',
    () => { reloadConfig(); tick(); }
  );

  // register disposables — VS Code cleans these up on deactivate
  context.subscriptions.push(
    statusBarItem,
    configWatcher,
    cmdOpenPanel,
    cmdSwitch,
    cmdAdd,
    cmdRefresh,
    { dispose: () => clearInterval(interval) }
  );
}

export function deactivate(): void {
  // all cleanup handled via context.subscriptions
}
