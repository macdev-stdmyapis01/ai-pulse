const vscode = require("vscode");

const PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    iconPeak: "$(warning)",
    iconOff: "$(check)",
    checkStatus: (now) => {
      const beijingHour = (now.getUTCHours() + 8) % 24;
      const isPeak = (beijingHour >= 9 && beijingHour < 12) || (beijingHour >= 14 && beijingHour < 18);
      return {
        isPeak,
        text: isPeak ? "PEAK LOAD (2x Price)" : "Off-Peak Window",
        tooltip: "Peak Windows: 9:00–12:00 & 14:00–18:00 China"
      };
    }
  },
  openai: {
    label: "OpenAI",
    iconPeak: "$(dashboard)",
    iconOff: "$(zap)",
    checkStatus: (now) => {
      const easternHour = (now.getUTCHours() - 4 + 24) % 24;
      const isHighTraffic = (easternHour >= 9 && easternHour < 17);
      return {
        isPeak: isHighTraffic,
        text: isHighTraffic ? "High API Congestion" : "Optimal Speed",
        tooltip: "High traffic expected during US business hours (9 AM - 5 PM EST)"
      };
    }
  }
};

let currentProviderKey = "deepseek"; 

function easternLabel(now) {
  const easternHour = (now.getUTCHours() - 4 + 24) % 24;
  const mins = String(now.getUTCMinutes()).padStart(2, '0');
  const ampm = easternHour >= 12 ? 'PM' : 'AM';
  const displayHour = easternHour % 12 || 12;
  return `${displayHour}:${mins} ${ampm}`;
}

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  
  const refresh = () => {
    const now = new Date();
    const provider = PROVIDERS[currentProviderKey];
    const status = provider.checkStatus(now);
    const et = easternLabel(now);
    
    const icon = status.isPeak ? provider.iconPeak : provider.iconOff;
    item.text = `${icon} ${provider.label}: ${status.isPeak ? "PEAK" : "Off-Peak"}`;
    
    item.tooltip = `AI Status Matrix: ${provider.label}\n` +
                   `Status: ${status.text}\n` +
                   `${status.tooltip}\n` +
                   `Local US Eastern Now: ${et}\n\n` +
                   `👉 Click status bar item to toggle active AI provider tracker.`;
                   
    item.backgroundColor = status.isPeak ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    item.command = "deepseek-pulse.toggleProvider"; 
    item.show();
  };

  const toggleCommand = vscode.commands.registerCommand("deepseek-pulse.toggleProvider", () => {
    const keys = Object.keys(PROVIDERS);
    const nextIndex = (keys.indexOf(currentProviderKey) + 1) % keys.length;
    currentProviderKey = keys[nextIndex];
    vscode.window.showInformationMessage(`DeepSeek-Pulse: Now tracking ${PROVIDERS[currentProviderKey].label} traffic patterns.`);
    refresh();
  });

  refresh();
  const timer = setInterval(refresh, 60_000); 
  
  context.subscriptions.push(item, toggleCommand, { dispose: () => clearInterval(timer) });
}

function deactivate() {}

module.exports = { activate, deactivate };
