export const PROVIDERS = ["codex", "gemini", "claude"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export const INDICATORS = [
  "codex",
  "gemini",
  "gptClaude",
  "argon",
  "claude",
] as const;
export type IndicatorId = (typeof INDICATORS)[number];
export type BarStyle = "full" | "compact" | "icon";
export type PanelTheme = "auto" | "dark" | "light";

export interface DisplaySettings {
  visibleProviders: ProviderId[];
  visibleIndicators: IndicatorId[];
  statusBarStyle: BarStyle;
  showIcons: boolean;
  showResetTime: boolean;
  showResetCredits: boolean;
  colorize: boolean;
  panelTheme: PanelTheme;
  refreshIntervalSeconds: number;
}

export interface AccountIdentity {
  provider: ProviderId;
  email?: string;
  name?: string;
  plan?: string;
  connected: boolean;
  detail?: string;
}

export interface KnownAccount extends AccountIdentity {
  id: string;
  lastSeen: string;
  active: boolean;
  sessionSaved: boolean;
}

export interface QuotaWindow {
  label: string;
  remainingPercent: number;
  resetsAt?: number;
  resetLabel: string;
}

export interface ProviderQuota {
  id: ProviderId;
  name: string;
  source: string;
  windows: QuotaWindow[];
  account?: AccountIdentity;
  updatedAt?: string;
  error?: string;
}

export interface DashboardState {
  providers: ProviderQuota[];
  accounts: KnownAccount[];
  settings: DisplaySettings;
  resetCredits: number;
  refreshing: boolean;
}

export function isProviderId(value: unknown): value is ProviderId {
  return PROVIDERS.some((id) => id === value);
}

export function validateSettings(value: unknown): Partial<DisplaySettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid settings data.");
  }
  const input = value as Record<string, unknown>;
  const result: Partial<DisplaySettings> = {};
  for (const key of [
    "showIcons",
    "showResetTime",
    "showResetCredits",
    "colorize",
  ] as const) {
    if (key in input) {
      if (typeof input[key] !== "boolean")
        throw new Error("Invalid appearance setting.");
      result[key] = input[key];
    }
  }
  if ("visibleProviders" in input) {
    if (
      !Array.isArray(input.visibleProviders) ||
      !input.visibleProviders.every(isProviderId)
    ) {
      throw new Error("Invalid provider selection.");
    }
    result.visibleProviders = [...new Set(input.visibleProviders)];
  }
  if ("visibleIndicators" in input) {
    if (
      !Array.isArray(input.visibleIndicators) ||
      !input.visibleIndicators.every((id) => INDICATORS.includes(id))
    ) {
      throw new Error("Invalid indicator selection.");
    }
    result.visibleIndicators = [
      ...new Set(input.visibleIndicators),
    ] as IndicatorId[];
  }
  if ("statusBarStyle" in input) {
    if (!["full", "compact", "icon"].includes(input.statusBarStyle as string))
      throw new Error("Invalid style.");
    result.statusBarStyle = input.statusBarStyle as BarStyle;
  }
  if ("panelTheme" in input) {
    if (!["auto", "dark", "light"].includes(input.panelTheme as string))
      throw new Error("Invalid theme.");
    result.panelTheme = input.panelTheme as PanelTheme;
  }
  if ("refreshIntervalSeconds" in input) {
    const interval = input.refreshIntervalSeconds;
    if (
      typeof interval !== "number" ||
      !Number.isInteger(interval) ||
      interval < 60 ||
      interval > 3600
    ) {
      throw new Error("Refresh interval must be between 60 and 3600 seconds.");
    }
    result.refreshIntervalSeconds = interval;
  }
  return result;
}

export function statusText(
  icon: string,
  label: string,
  remaining: number,
  resetTime: string,
  settings: DisplaySettings,
): string {
  const iconOnly = settings.statusBarStyle === "icon";
  const prefix = settings.showIcons || iconOnly ? `${icon} ` : "";
  if (iconOnly) return prefix.trim();
  const title = settings.statusBarStyle === "full" ? `${label} ` : "";
  const countdown = settings.showResetTime ? ` · ${resetTime}` : "";
  return `${prefix}${title}%${remaining}${countdown}`;
}
