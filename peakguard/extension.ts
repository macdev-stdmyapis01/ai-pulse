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
  startMin: number; // pre-parsed at load time — zero cost on tick
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
// SECTION 2 — PEAK ENGINE (pure functions)
// Pre-parsed windows keep the hot path allocation-free.
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
 
// timezone resolution cached between reloads
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
    '*Click to manage providers*'
  ].filter(Boolean).join('\n\n'), true);
 
  md.isTrusted = true;
  return md;
}
 
// ─────────────────────────────────────────────
// SECTION 5 — CONFIG & PROVIDER LOADING
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
// Data-driven table — one loop, no repetition.
// ─────────────────────────────────────────────
 
const ADD_STEPS = [
  { group: 'Name',      prompt: 'Provider display name',                                 placeholder: 'e.g. Kimi K2.6',       numeric: false },
  { group: 'Off-peak',  prompt: 'Input · Cache Miss per 1M tokens (USD)',                placeholder: '0.14',                  numeric: true  },
  { group: 'Off-peak',  prompt: 'Input · Cache Hit per 1M tokens (USD)',                 placeholder: '0.0028',                numeric: true  },
  { group: 'Off-peak',  prompt: 'Output · Generated per 1M tokens (USD)',                placeholder: '0.28',                  numeric: true  },
  { group: 'Peak',      prompt: 'Input · Cache Miss per 1M (USD) — enter 0 if no peak', placeholder: '0.28',                  numeric: true  },
  { group: 'Peak',      prompt: 'Input · Cache Hit per 1M tokens (USD)',                 placeholder: '0.0056',                numeric: true  },
  { group: 'Peak',      prompt: 'Output · Generated per 1M tokens (USD)',                placeholder: '0.56',                  numeric: true  },
  { group: 'Timezone',  prompt: 'Timezone for peak windows',                             placeholder: 'Asia/Shanghai',         numeric: false, defaultVal: () => Intl.DateTimeFormat().resolvedOptions().timeZone },
  { group: 'Windows',   prompt: 'Peak windows in UTC — HH:MM-HH:MM, comma separated',  placeholder: '01:00-04:00, 06:00-10:00', numeric: false }
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
// SECTION 7 — MENU
// ─────────────────────────────────────────────
 
type MenuItem = vscode.QuickPickItem & { action: string; providerId?: string };
 
const STATE_ICON:  Record<PeakState, string> = { offpeak: '◉', approaching: '◑', peak: '⚡', peak_announced: '⏸' };
const STATE_LABEL: Record<PeakState, (r: StateResult) => string> = {
  offpeak:        ()  => 'off-peak',
  approaching:    r   => `peak in ${fmtMin(r.minutesToNext)}`,
  peak:           ()  => 'PEAK',
  peak_announced: ()  => 'peak window'
};
 
async function showMenu(
  providers: Provider[], activeId: string, zone: string,
  onSwitch: (id: string) => void, onAdd: () => void,
  onDelete: (id: string) => void, onRefresh: () => void
): Promise<void> {
  const nowMin = utcMin(new Date());
 
  const items: MenuItem[] = [
    ...providers.map(p => {
      const r = calcState(nowMin, p);
      const isActive   = p.id === activeId;
      const isBundled  = BUNDLED_IDS.has(p.id);
      const tags = [isActive ? '● active' : '', isBundled ? 'built-in' : ''].filter(Boolean).join('  ');
      return {
        label:       `${isActive ? '$(circle-filled)' : '$(circle-outline)'}  ${p.name}`,
        description: `${STATE_ICON[r.state]} ${STATE_LABEL[r.state](r)} · miss ${fmtPrice(r.currentPricing.input_miss)} · hit ${fmtPrice(r.currentPricing.input_hit)}`,
        detail:      tags ? `      ${tags}` : undefined,
        action:      isBundled ? 'switch' : 'manage',
        providerId:  p.id
      };
    }),
    { label: '', kind: vscode.QuickPickItemKind.Separator, action: '' },
    { label: '$(add)      Add Provider', description: 'Configure a new API provider with custom pricing', action: 'add'      },
    { label: '$(refresh)  Refresh',      description: 'Reload config and recalculate state',               action: 'refresh'  },
    { label: '$(gear)     Settings',     description: 'Open PeakGuard settings',                           action: 'settings' }
  ];
 
  const picked = await vscode.window.showQuickPick(items, {
    title: 'PeakGuard', placeHolder: 'Select provider · or manage', matchOnDescription: true
  }) as MenuItem | undefined;
 
  if (!picked?.action) { return; }
 
  switch (picked.action) {
    case 'add':      onAdd();     return;
    case 'refresh':  onRefresh(); return;
    case 'settings': vscode.commands.executeCommand('workbench.action.openSettings', 'peakGuard'); return;
  }
 
  if (!picked.providerId) { return; }
 
  if (BUNDLED_IDS.has(picked.providerId) || picked.providerId === activeId) {
    onSwitch(picked.providerId); return;
  }
 
  const sub = await vscode.window.showQuickPick([
    { label: '$(arrow-right)  Switch to this provider', action: 'switch' },
    { label: '$(trash)        Remove this provider',    action: 'delete' }
  ], { title: providers.find(p => p.id === picked.providerId)?.name ?? '', placeHolder: 'Choose action' });
 
  if (sub?.action === 'switch') { onSwitch(picked.providerId); }
  if (sub?.action === 'delete') { onDelete(picked.providerId); }
}
 
// ─────────────────────────────────────────────
// SECTION 8 — ACTIVATE
// ─────────────────────────────────────────────
 
export function activate(ctx: vscode.ExtensionContext): void {
  let providers: Provider[] = [];
  let activeId = '';
  let cfg      = readConfig();
 
  const peakGuardCfg = () => vscode.workspace.getConfiguration('peakGuard');
 
  function reload(): void {
    cfg       = readConfig();
    providers = mergeProviders(loadBundled(ctx), cfg.providers);
    activeId  = providers.find(p => p.id === cfg.activeProvider) ? cfg.activeProvider : (providers[0]?.id ?? '');
    _cachedTz = undefined; // invalidate timezone cache
  }
 
  async function setActive(id: string): Promise<void> {
    activeId = id;
    await peakGuardCfg().update('activeProvider', id, vscode.ConfigurationTarget.Global);
    tick();
    vscode.window.setStatusBarMessage(`PeakGuard: switched to ${providers.find(p => p.id === id)?.name}`, 3000);
  }
 
  async function addProvider(): Promise<void> {
    const p = await addProviderFlow();
    if (!p) { return; }
    await peakGuardCfg().update('providers', [...cfg.providers, p], vscode.ConfigurationTarget.Global);
    reload(); tick();
    vscode.window.showInformationMessage(`PeakGuard: ${p.name} added.`);
  }
 
  async function deleteProvider(id: string): Promise<void> {
    await peakGuardCfg().update('providers', cfg.providers.filter(p => p.id !== id), vscode.ConfigurationTarget.Global);
    if (activeId === id) { activeId = providers.find(p => p.id !== id)?.id ?? ''; }
    reload(); tick();
    vscode.window.showInformationMessage('PeakGuard: provider removed.');
  }
 
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  bar.command = 'peakGuard.openMenu';
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
    } catch (e) {
      console.error('PeakGuard: tick error', e);
      bar.text = '○ PG · error'; bar.color = '#6b7280';
    }
  }
 
  reload();
  tick();
 
  const interval = setInterval(tick, 60_000);
 
  const openMenu = () => showMenu(
    providers, activeId, resolveZone(cfg.displayTimezone),
    id => setActive(id), () => addProvider(),
    id => deleteProvider(id),
    () => { reload(); tick(); vscode.window.setStatusBarMessage('PeakGuard: refreshed', 2000); }
  );
 
  ctx.subscriptions.push(
    bar,
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('peakGuard')) { reload(); tick(); } }),
    vscode.commands.registerCommand('peakGuard.openMenu',       openMenu),
    vscode.commands.registerCommand('peakGuard.openPanel',      openMenu),
    vscode.commands.registerCommand('peakGuard.switchProvider', openMenu),
    vscode.commands.registerCommand('peakGuard.addProvider',    () => addProvider()),
    vscode.commands.registerCommand('peakGuard.refresh',        () => { reload(); tick(); vscode.window.setStatusBarMessage('PeakGuard: refreshed', 2000); }),
    { dispose: () => clearInterval(interval) }
  );
}
 
export function deactivate(): void {}