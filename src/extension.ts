import * as vscode from "vscode";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import * as http from "node:http";
import * as https from "node:https";
import {
  AccountLoginFlow,
  AccountDirectory,
  readClaudeAccount,
  startAccountLogin,
} from "./accounts";
import { Dashboard } from "./dashboard";
import {
  AccountIdentity,
  DashboardState,
  DisplaySettings,
  INDICATORS,
  IndicatorId,
  ProviderId,
  QuotaWindow,
  statusText,
} from "./dashboard-model";

const execFileAsync = promisify(execFile);
const APP_SERVER_TIMEOUT_MS = 15_000;
const RESET_ATTEMPT_STORAGE_KEY = "resetCreditPendingIdempotencyKey";
const YELLOW_REMAINING_PERCENT = 30;
const ORANGE_REMAINING_PERCENT = 20;
const RED_REMAINING_PERCENT = 10;
const COUNTDOWN_REFRESH_INTERVAL_MS = 60_000;
const VISIBLE_PROVIDERS_SETTING = "visibleProviders";
const DEFAULT_VISIBLE_PROVIDERS = ["codex", "gemini", "claude"];
const PROVIDER_ICONS = {
  codex: "$(ai-limit-codex)",
  gemini: "$(ai-limit-gemini)",
  claude: "$(ai-limit-claude)",
} as const;
const CLAUDE_USAGE_API_PATH = "/api/oauth/usage";
const CLAUDE_USAGE_TIMEOUT_MS = 8_000;
const ANTIGRAVITY_API_TIMEOUT_MS = 5_000;
const ANTIGRAVITY_USAGE_API_PATH =
  "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const CLIENT_INFO = {
  name: "ai-limit-status-vscode",
  title: "AI Limit Status",
  version: "1.3.3",
};

const POWERSHELL_CONNECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$servers = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -in @('language_server.exe', 'agy.exe') -and
  $_.CommandLine -match '--app_data_dir(?:=|\s+)antigravity(?:\s|$)'
})
$connections = foreach ($server in $servers) {
  $token = [regex]::Match($server.CommandLine, '--csrf_token(?:=|\s+)([a-zA-Z0-9-]+)').Groups[1].Value
  $ports = @(Get-NetTCPConnection -OwningProcess $server.ProcessId -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique)
  if ($token -and $ports.Count -gt 0) {
    [pscustomobject]@{ ports = $ports; csrfToken = $token }
  }
}
if ($connections) { ConvertTo-Json -InputObject @($connections) -Compress -Depth 3 } else { '[]' }
`;

type ClaudeUsageWindow = {
  utilization?: number;
  resets_at?: string;
};

type ClaudeUsageResponse = {
  five_hour?: ClaudeUsageWindow;
  seven_day?: ClaudeUsageWindow;
  seven_day_sonnet?: ClaudeUsageWindow;
  seven_day_opus?: ClaudeUsageWindow;
};

type AntigravityConnection = {
  ports: number[] | number;
  csrfToken: string;
};

type AntigravityQuotaBucket = {
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
  disabled?: boolean;
};

type AntigravityQuotaResponse = {
  userStatus?: {
    email?: string;
    name?: string;
    planStatus?: { planInfo?: { planName?: string } };
  };
  response?: {
    groups?: Array<{
      displayName?: string;
      buckets?: AntigravityQuotaBucket[];
    }>;
  };
};

type AntigravityQuotaGroup = {
  key: "gemini" | "gptClaude" | "argon";
  label: string;
  buckets: AntigravityQuotaBucket[];
};

type UsageWindow = {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
};

type RateLimit = {
  limitId?: string | null;
  primary?: UsageWindow | null;
  secondary?: UsageWindow | null;
  planType?: string | null;
};

type RateLimitResponse = {
  rateLimits?: RateLimit | null;
  rateLimitsByLimitId?: Record<string, RateLimit | null> | null;
  rateLimitResetCredits?: { availableCount: number } | null;
};

type ResetCreditConsumeResponse = {
  outcome: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";
};

type JsonRpcMessage = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

type RenderedWindow = {
  label: string;
  remainingPercent: number;
  resetsAt?: number;
  duration: number;
};

export function activate(context: vscode.ExtensionContext): void {
  const accounts = new AccountDirectory(context);
  const accountLoginFlows = new Map<vscode.Terminal, AccountLoginFlow>();
  let dashboard: Dashboard | undefined;
  let dashboardRefreshing = false;
  let codexErrorMessage: string | undefined;
  let antigravityIdentity: AccountIdentity = {
    provider: "gemini",
    connected: false,
  };
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  const resetItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    101,
  );
  const claudeItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99,
  );
  const geminiItems: Array<{
    item: vscode.StatusBarItem;
    key: AntigravityQuotaGroup["key"];
    label: string;
  }> = [
    {
      item: vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        98,
      ),
      key: "gemini",
      label: "Gemini",
    },
    {
      item: vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        97,
      ),
      key: "gptClaude",
      label: "Other",
    },
    {
      item: vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        96,
      ),
      key: "argon",
      label: "Argon",
    },
  ];
  item.command = "codexUsage.openMenu";
  item.text = `$(sync~spin) ${PROVIDER_ICONS.codex} Codex limits`;
  item.tooltip = "Loading Codex usage limits";
  if (isIndicatorVisible("codex")) item.show();
  resetItem.command = "codexUsage.consumeResetCredit";
  resetItem.color = STATUS_COLORS.yellow;
  claudeItem.command = "codexUsage.openMenu";
  claudeItem.text = `${PROVIDER_ICONS.claude} Claude limits loading`;
  claudeItem.tooltip = "Loading Claude subscription limits";
  if (isIndicatorVisible("claude")) claudeItem.show();
  for (const { item: geminiItem, label, key } of geminiItems) {
    geminiItem.command = "codexUsage.openMenu";
    geminiItem.text = `${PROVIDER_ICONS.gemini} ${label} quota data pending`;
    geminiItem.tooltip = "Antigravity must be open and signed in";
    if (isIndicatorVisible(key)) geminiItem.show();
  }

  let windows: RenderedWindow[] = [];
  let planType: string | null | undefined;
  let lastUpdatedAt: Date | undefined;
  let availableResetCount: number | undefined;
  let claudeWindows: RenderedWindow[] = [];
  let claudeLastUpdatedAt: Date | undefined;
  let claudeErrorMessage: string | undefined;
  let antigravityGroups: AntigravityQuotaGroup[] = [];
  let antigravityLastUpdatedAt: Date | undefined;
  let antigravityErrorMessage: string | undefined;
  let refreshInProgress = false;
  let claudeRefreshInProgress = false;
  let antigravityRefreshInProgress = false;
  let resetInProgress = false;

  const updateResetStatus = (): void => {
    if (
      !isIndicatorVisible("codex") ||
      !getDisplaySettings().showResetCredits ||
      availableResetCount === undefined ||
      availableResetCount <= 0
    ) {
      resetItem.hide();
      return;
    }

    resetItem.text = `Reset ${availableResetCount ?? "—"}`;
    resetItem.tooltip = `${availableResetCount} reset credit(s) available. Clicking checks limit eligibility and asks for confirmation before use.`;
    resetItem.show();
  };

  const updateStatus = (): void => {
    if (!isIndicatorVisible("codex")) {
      item.hide();
      return;
    }
    if (windows.length === 0) {
      item.text = `${PROVIDER_ICONS.codex} ${codexErrorMessage ? "Codex unavailable" : "Waiting for Codex limit"}`;
      item.tooltip =
        codexErrorMessage ?? "Waiting for a Codex usage window.";
      item.color = undefined;
      item.show();
      return;
    }

    const primary = selectStatusWindow(windows);
    const remainingTime = formatRemainingTime(primary.resetsAt);
    item.text = statusText(
      PROVIDER_ICONS.codex,
      "Codex",
      primary.remainingPercent,
      remainingTime,
      getDisplaySettings(),
    );
    item.backgroundColor = undefined;
    item.color = getStatusBarColor(primary.remainingPercent);
    item.tooltip = [
      "Codex usage limits",
      ...windows.map(formatWindow),
      planType ? `Plan: ${planType}` : undefined,
      lastUpdatedAt
        ? `Last updated: ${lastUpdatedAt.toLocaleTimeString("en-US")}`
        : undefined,
      "Click to refresh or change the interval",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    item.show();
  };

  const updateClaudeStatus = (): void => {
    if (!isIndicatorVisible("claude")) {
      claudeItem.hide();
      return;
    }
    if (claudeWindows.length === 0) {
      claudeItem.text = `$(warning) ${PROVIDER_ICONS.claude} Claude limit unavailable`;
      claudeItem.color = undefined;
      claudeItem.tooltip =
        claudeErrorMessage ?? "Claude usage information is unavailable.";
      claudeItem.show();
      return;
    }

    const primary = selectStatusWindow(claudeWindows);
    claudeItem.text = statusText(
      PROVIDER_ICONS.claude,
      "Claude",
      primary.remainingPercent,
      formatRemainingTime(primary.resetsAt),
      getDisplaySettings(),
    );
    claudeItem.color = getStatusBarColor(primary.remainingPercent);
    claudeItem.backgroundColor = undefined;
    claudeItem.tooltip = [
      "Claude subscription usage limits",
      ...claudeWindows.map(formatWindow),
      claudeLastUpdatedAt
        ? `Last updated: ${claudeLastUpdatedAt.toLocaleTimeString("en-US")}`
        : undefined,
      "Click to refresh or choose visible limits",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    claudeItem.show();
  };

  const updateAntigravityStatus = (): void => {
    for (const { item: statusItem, key, label } of geminiItems) {
      if (!isIndicatorVisible(key)) {
        statusItem.hide();
        continue;
      }

      const group = antigravityGroups.find(
        (candidate) => candidate.key === key,
      );
      if (!group) {
        if (antigravityErrorMessage) {
          statusItem.text = `$(warning) ${PROVIDER_ICONS.gemini} Antigravity quota unavailable`;
          statusItem.color = undefined;
          statusItem.backgroundColor = undefined;
          statusItem.tooltip = antigravityErrorMessage;
          statusItem.show();
        } else {
          statusItem.hide();
        }
        continue;
      }

      const primaryBucket = selectAntigravityStatusBucket(group.buckets);
      const remainingPercent = getAntigravityRemainingPercent(primaryBucket);
      statusItem.text = antigravityStatusText(
        PROVIDER_ICONS.gemini,
        label,
        group.buckets,
        getDisplaySettings(),
      );
      statusItem.color = getStatusBarColor(remainingPercent);
      statusItem.backgroundColor = undefined;
      statusItem.tooltip = [
        `Antigravity ${label} limits`,
        ...group.buckets.map((bucket) => {
          const bucketLabel =
            bucket.window === "weekly" ? "Weekly limit" : "5-hour limit";
          const resetLabel =
            bucket.window === "weekly" ? "Weekly reset" : "Reset";
          return `${bucketLabel}: %${getAntigravityRemainingPercent(bucket)} remaining · ${resetLabel}: ${formatRemainingTime(getAntigravityResetTimestamp(bucket.resetTime))}`;
        }),
        antigravityLastUpdatedAt
          ? `Last updated: ${antigravityLastUpdatedAt.toLocaleTimeString("en-US")}`
          : undefined,
        "Click to refresh or choose visible limits",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
      statusItem.show();
    }
  };

  const refresh = async (showErrors: boolean): Promise<void> => {
    if (refreshInProgress) return;
    refreshInProgress = true;

    try {
      const result = await readRateLimits();
      codexErrorMessage = undefined;
      const rateLimit = selectCodexLimit(result);
      windows = renderWindows(rateLimit);
      planType = rateLimit.planType;
      availableResetCount = result.rateLimitResetCredits?.availableCount;
      lastUpdatedAt = new Date();
      updateResetStatus();
      if (windows.length === 0) {
        if (!isIndicatorVisible("codex")) {
          item.hide();
          return;
        }
        item.text = `$(warning) ${PROVIDER_ICONS.codex} No Codex limits`;
        item.backgroundColor = undefined;
        item.color = undefined;
        item.tooltip =
          "No displayable usage windows were found for this account.";
        return;
      }
      updateStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      codexErrorMessage = message;
      windows = [];
      availableResetCount = undefined;
      updateResetStatus();
      if (!isIndicatorVisible("codex")) {
        item.hide();
        return;
      }
      item.text = `$(warning) ${PROVIDER_ICONS.codex} Codex limits unavailable`;
      item.backgroundColor = undefined;
      item.color = undefined;
      item.tooltip = message;
      if (showErrors) {
        void vscode.window.showErrorMessage(
          `Could not retrieve Codex limits: ${message}`,
        );
      }
    } finally {
      refreshInProgress = false;
    }
  };

  const refreshClaude = async (showErrors: boolean): Promise<void> => {
    if (claudeRefreshInProgress) return;
    claudeRefreshInProgress = true;
    try {
      const response = await readClaudeUsage();
      claudeWindows = renderClaudeWindows(response);
      claudeLastUpdatedAt = new Date();
      claudeErrorMessage =
        claudeWindows.length > 0
          ? undefined
          : "No Claude subscription usage windows were found in the response.";
      updateClaudeStatus();
    } catch (error) {
      claudeErrorMessage =
        error instanceof Error ? error.message : String(error);
      claudeWindows = [];
      updateClaudeStatus();
      if (showErrors) {
        void vscode.window.showErrorMessage(
          `Could not retrieve Claude limits: ${claudeErrorMessage}`,
        );
      }
    } finally {
      claudeRefreshInProgress = false;
    }
  };

  const refreshAntigravity = async (showErrors: boolean): Promise<void> => {
    if (antigravityRefreshInProgress) return;
    antigravityRefreshInProgress = true;
    try {
      const response = await fetchAntigravityQuota();
      antigravityIdentity = {
        provider: "gemini",
        connected: true,
        email:
          typeof response.userStatus?.email === "string"
            ? response.userStatus.email
            : undefined,
        name:
          typeof response.userStatus?.name === "string"
            ? response.userStatus.name
            : undefined,
        plan:
          typeof response.userStatus?.planStatus?.planInfo?.planName ===
          "string"
            ? response.userStatus.planStatus.planInfo.planName
            : undefined,
        detail: response.userStatus?.email
          ? undefined
          : "Connected to the local quota service; account email was not provided.",
      };
      antigravityGroups = parseAntigravityQuotaGroups(response);
      antigravityErrorMessage =
        antigravityGroups.length > 0
          ? undefined
          : "No available limits were found in the Antigravity quota response.";
      antigravityLastUpdatedAt = new Date();
      updateAntigravityStatus();
    } catch (error) {
      antigravityErrorMessage =
        error instanceof Error ? error.message : String(error);
      antigravityGroups = [];
      antigravityIdentity = {
        provider: "gemini",
        connected: false,
        detail: antigravityErrorMessage,
      };
      updateAntigravityStatus();
      if (showErrors) {
        void vscode.window.showErrorMessage(
          `Could not retrieve Gemini limits: ${antigravityErrorMessage}`,
        );
      }
    } finally {
      antigravityRefreshInProgress = false;
    }
  };

  const refreshAll = async (showErrors: boolean): Promise<void> => {
    if (dashboardRefreshing) return;
    dashboardRefreshing = true;
    dashboard?.publish();
    try {
      const [codexAccount, claudeAccount] = await Promise.all([
        appServerRequest<{
          account?: { type: string; email?: string; planType?: string };
        }>("account/read", { refreshToken: false })
          .then(({ account }): AccountIdentity => ({
            provider: "codex",
            connected: !!account,
            email: account?.email,
            plan: account?.planType,
            detail:
              account?.type === "apiKey" ? "API key session" : undefined,
          }))
          .catch((): AccountIdentity => ({
            provider: "codex",
            connected: false,
            detail: "Could not read the Codex session.",
          })),
        readClaudeAccount(),
      ]);
      await accounts.record([codexAccount, claudeAccount]);
      await Promise.all([
        refresh(showErrors),
        refreshClaude(showErrors),
        refreshAntigravity(showErrors),
      ]);
      await accounts.record([antigravityIdentity]);
    } finally {
      dashboardRefreshing = false;
      dashboard?.publish();
    }
  };

  const useResetCredit = async (): Promise<void> => {
    if (resetInProgress) return;
    if (refreshInProgress) {
      void vscode.window.showInformationMessage(
        "Limits are updating; try again shortly.",
      );
      return;
    }

    resetInProgress = true;
    try {
      const latestResult = await readRateLimits();
      const latestLimit = selectCodexLimit(latestResult);
      windows = renderWindows(latestLimit);
      planType = latestLimit.planType;
      availableResetCount = latestResult.rateLimitResetCredits?.availableCount;
      lastUpdatedAt = new Date();
      updateResetStatus();
      updateStatus();

      if (availableResetCount === undefined) {
        throw new Error(
          "Could not read the number of reset credits. No credits were used.",
        );
      }
      if (availableResetCount === 0) {
        void vscode.window.showInformationMessage(
          "No reset credits are available.",
        );
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `${availableResetCount} reset credit(s) available. Use one? If an eligible limit is found, it will be reset and one credit will be used.`,
        { modal: true },
        "Use one reset credit",
      );
      if (confirmed !== "Use one reset credit") return;

      const idempotencyKey =
        context.globalState.get<string>(RESET_ATTEMPT_STORAGE_KEY) ??
        randomUUID();
      await context.globalState.update(
        RESET_ATTEMPT_STORAGE_KEY,
        idempotencyKey,
      );
      const result = await consumeResetCredit(idempotencyKey);
      await context.globalState.update(RESET_ATTEMPT_STORAGE_KEY, undefined);
      if (result.outcome === "reset") {
        void vscode.window.showInformationMessage(
          "One reset credit was used.",
        );
        await refresh(false);
      } else if (result.outcome === "nothingToReset") {
        void vscode.window.showInformationMessage(
          "No Codex limit can be reset right now.",
        );
        await refresh(false);
      } else if (result.outcome === "noCredit") {
        void vscode.window.showInformationMessage(
          "No reset credits remain; limits have been refreshed.",
        );
        await refresh(false);
      } else {
        void vscode.window.showInformationMessage(
          "This reset request was already processed; limits have been refreshed.",
        );
        await refresh(false);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `Could not use a reset credit: ${message}`,
      );
      await refresh(false);
    } finally {
      resetInProgress = false;
      updateResetStatus();
    }
  };

  const getDashboardState = (): DashboardState => {
    const quotaWindows = (entries: RenderedWindow[]): QuotaWindow[] =>
      entries.map((entry) => ({
        label: entry.label,
        remainingPercent: entry.remainingPercent,
        resetsAt: entry.resetsAt,
        resetLabel: formatRemainingTime(entry.resetsAt),
      }));
    return {
      providers: [
        {
          id: "codex",
          name: "Codex",
          source: "OpenAI • Codex CLI",
          windows: quotaWindows(windows),
          account: accounts.get("codex"),
          updatedAt: lastUpdatedAt?.toISOString(),
          error: codexErrorMessage,
        },
        {
          id: "gemini",
          name: "Gemini & Antigravity",
          source: "Google • Antigravity",
          account: accounts.get("gemini"),
          updatedAt: antigravityLastUpdatedAt?.toISOString(),
          error: antigravityErrorMessage,
          windows: antigravityGroups.flatMap((group) =>
            group.buckets.map((bucket) => {
              const resetsAt = getAntigravityResetTimestamp(bucket.resetTime);
              return {
                label:
                  group.label +
                  " · " +
                  (bucket.window === "weekly" ? "Weekly" : "5-hour"),
                remainingPercent: getAntigravityRemainingPercent(bucket),
                resetsAt,
                resetLabel: formatRemainingTime(resetsAt),
              };
            }),
          ),
        },
        {
          id: "claude",
          name: "Claude",
          source: "Anthropic • Claude Code",
          windows: quotaWindows(claudeWindows),
          account: accounts.get("claude"),
          updatedAt: claudeLastUpdatedAt?.toISOString(),
          error: claudeErrorMessage,
        },
      ],
      accounts: accounts.list(),
      settings: getDisplaySettings(),
      resetCredits: availableResetCount ?? 0,
      refreshing: dashboardRefreshing,
    };
  };
  dashboard = new Dashboard(context, getDashboardState, {
    refresh: () => refreshAll(false),
    save: async (settings) => {
      for (const [key, value] of Object.entries(settings)) {
        const section =
          key === "refreshIntervalSeconds" ? "codexUsage" : "aiQuotaStatus";
        await vscode.workspace
          .getConfiguration(section)
          .update(key, value, vscode.ConfigurationTarget.Global);
      }
    },
    login: async (provider, email) => {
      const flow = await startAccountLogin(
        provider,
        resolveCodexExecutable,
        context.globalStorageUri.fsPath,
        email,
      );
      if (!flow) return "managed";
      accountLoginFlows.set(flow.terminal, flow);
      return "isolated";
    },
    switchAccount: async (provider, id) => {
      if (provider === "gemini") {
        const account = accounts
          .list()
          .find((entry) => entry.id === id && entry.provider === provider);
        await startAccountLogin(
          provider,
          resolveCodexExecutable,
          context.globalStorageUri.fsPath,
          account?.email,
        );
        return "manage";
      }
      await refreshAll(false);
      await accounts.switchTo(id, provider);
      await refreshAll(false);
      return "switched";
    },
    forget: (id) => accounts.forget(id),
    reset: async () => {
      await useResetCredit();
      dashboard?.publish();
    },
  });

  const countdownTimer = setInterval(() => {
    updateStatus();
    updateClaudeStatus();
    updateAntigravityStatus();
    dashboard?.publish();
  }, COUNTDOWN_REFRESH_INTERVAL_MS);
  context.subscriptions.push(
    item,
    resetItem,
    claudeItem,
    ...geminiItems.map(({ item: statusItem }) => statusItem),
    vscode.commands.registerCommand("codexUsage.refresh", () =>
      refreshAll(true),
    ),
    vscode.commands.registerCommand("codexUsage.openMenu", () =>
      dashboard?.open(),
    ),
    vscode.commands.registerCommand(
      "codexUsage.consumeResetCredit",
      useResetCredit,
    ),
    dashboard,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("aiQuotaStatus") ||
        event.affectsConfiguration("codexUsage.refreshIntervalSeconds")
      ) {
        updateStatus();
        updateResetStatus();
        updateClaudeStatus();
        updateAntigravityStatus();
        dashboard?.publish();
      }
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      const loginFlow = accountLoginFlows.get(terminal);
      if (loginFlow) {
        accountLoginFlows.delete(terminal);
        void (async () => {
          const sourcePath = join(
            loginFlow.profileDirectory,
            loginFlow.provider === "codex" ? "auth.json" : ".credentials.json",
          );
          try {
            if (!isFile(sourcePath)) {
              void vscode.window.showInformationMessage(
                "No new account was saved. Your current session remains active.",
              );
              return;
            }

            let identity: AccountIdentity;
            if (loginFlow.provider === "codex") {
              const { account } = await appServerRequest<{
                account?: { email?: string; planType?: string };
              }>(
                "account/read",
                { refreshToken: false },
                { CODEX_HOME: loginFlow.profileDirectory },
              );
              identity = {
                provider: "codex",
                connected: !!account,
                email: account?.email,
                plan: account?.planType,
              };
            } else {
              identity = await readClaudeAccount(loginFlow.profileDirectory);
            }

            await accounts.saveLoginSession(identity, sourcePath);
            dashboard?.publish();
            void vscode.window.showInformationMessage(
              `${identity.email} was added. Your current ${loginFlow.provider === "codex" ? "Codex" : "Claude"} session remains active.`,
            );
          } catch (error) {
            void vscode.window.showErrorMessage(
              `Could not save the new account: ${error instanceof Error ? error.message : String(error)}`,
            );
          } finally {
            await rm(loginFlow.profileDirectory, {
              recursive: true,
              force: true,
            }).catch(() => undefined);
          }
        })();
        return;
      }
      if (/^(Codex|Claude|Antigravity) •/.test(terminal.name))
        void refreshAll(false);
    }),
    {
      dispose: () => clearInterval(countdownTimer),
    },
  );
  scheduleRefresh(context, refreshAll);
  void refreshAll(false);
}

function isProviderVisible(providerId: string): boolean {
  const visibleProviders = vscode.workspace
    .getConfiguration("aiQuotaStatus")
    .get<string[]>(VISIBLE_PROVIDERS_SETTING, DEFAULT_VISIBLE_PROVIDERS);
  return visibleProviders.includes(providerId);
}

function getDisplaySettings(): DisplaySettings {
  const config = vscode.workspace.getConfiguration("aiQuotaStatus");
  return {
    visibleProviders: config.get<ProviderId[]>(
      VISIBLE_PROVIDERS_SETTING,
      DEFAULT_VISIBLE_PROVIDERS as ProviderId[],
    ),
    visibleIndicators: config.get<IndicatorId[]>("visibleIndicators", [
      ...INDICATORS,
    ]),
    statusBarStyle: config.get("statusBarStyle", "full"),
    showIcons: config.get("showIcons", true),
    showResetTime: config.get("showResetTime", true),
    showResetCredits: config.get("showResetCredits", true),
    colorize: config.get("colorize", true),
    panelTheme: config.get("panelTheme", "auto"),
    refreshIntervalSeconds: vscode.workspace
      .getConfiguration("codexUsage")
      .get("refreshIntervalSeconds", 300),
  };
}

function isIndicatorVisible(id: IndicatorId): boolean {
  const provider = id === "gptClaude" || id === "argon" ? "gemini" : id;
  return (
    isProviderVisible(provider) &&
    getDisplaySettings().visibleIndicators.includes(id)
  );
}

export function deactivate(): void {}

function scheduleRefresh(
  context: vscode.ExtensionContext,
  refresh: (showErrors: boolean) => Promise<void>,
): void {
  let timer: NodeJS.Timeout;
  const resetTimer = (): void => {
    clearInterval(timer);
    const intervalSeconds = vscode.workspace
      .getConfiguration("codexUsage")
      .get<number>("refreshIntervalSeconds", 300);
    timer = setInterval(() => void refresh(false), intervalSeconds * 1000);
  };
  resetTimer();

  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexUsage.refreshIntervalSeconds")) {
        resetTimer();
      }
    }),
  );
}

function selectCodexLimit(response: RateLimitResponse): RateLimit {
  const exactMatch = response.rateLimitsByLimitId?.codex;
  if (exactMatch) return exactMatch;

  if (response.rateLimits?.limitId === "codex") return response.rateLimits;
  throw new Error("No limit information was found for the Codex account.");
}

function renderWindows(rateLimit: RateLimit): RenderedWindow[] {
  return [rateLimit.primary, rateLimit.secondary]
    .filter(
      (window): window is UsageWindow =>
        window !== null && window !== undefined,
    )
    .filter(
      (window) =>
        typeof window.usedPercent === "number" &&
        Number.isFinite(window.usedPercent),
    )
    .map((window) => {
      const duration = window.windowDurationMins ?? 0;
      return {
        label: formatWindowLabel(duration),
        remainingPercent: Math.max(
          0,
          Math.min(100, Math.round(100 - (window.usedPercent ?? 0))),
        ),
        resetsAt: window.resetsAt ?? undefined,
        duration,
      };
    })
    .sort((left, right) => left.duration - right.duration);
}

function selectStatusWindow(windows: RenderedWindow[]): RenderedWindow {
  const fiveHour = windows.find((w) => w.duration > 0 && w.duration <= 300);
  const weekly = windows.find((w) => w.duration >= 10080);

  if (weekly && weekly.remainingPercent === 0) {
    return weekly;
  }

  return fiveHour ?? weekly ?? windows[0];
}

function renderClaudeWindows(response: ClaudeUsageResponse): RenderedWindow[] {
  const usageWindows: Array<{
    key: keyof ClaudeUsageResponse;
    label: string;
    duration: number;
  }> = [
    { key: "five_hour", label: "5-hour", duration: 300 },
    { key: "seven_day", label: "Week", duration: 10080 },
    { key: "seven_day_sonnet", label: "Sonnet weekly", duration: 10080 },
    { key: "seven_day_opus", label: "Opus weekly", duration: 10080 },
  ];

  return usageWindows.flatMap(({ key, label, duration }) => {
    const usageWindow = response[key];
    const utilization = usageWindow?.utilization;
    if (typeof utilization !== "number" || !Number.isFinite(utilization))
      return [];

    const usedPercent = Math.max(0, Math.min(100, utilization));
    const resetTime = usageWindow?.resets_at
      ? Date.parse(usageWindow.resets_at)
      : Number.NaN;
    return [
      {
        label,
        remainingPercent: Math.max(
          0,
          Math.min(100, Math.round(100 - usedPercent)),
        ),
        resetsAt: Number.isFinite(resetTime)
          ? Math.floor(resetTime / 1000)
          : undefined,
        duration,
      },
    ];
  });
}

function parseAntigravityQuotaGroups(
  response: AntigravityQuotaResponse,
): AntigravityQuotaGroup[] {
  return (response.response?.groups ?? []).flatMap((group) => {
    const sourceLabel = group.displayName?.trim().toLowerCase();
    const buckets = (group.buckets ?? [])
      .filter((bucket) => typeof bucket.remainingFraction === "number")
      .sort(
        (left, right) =>
          getAntigravityWindowOrder(left.window) -
          getAntigravityWindowOrder(right.window),
      );
    if (!sourceLabel || buckets.length === 0) return [];

    const key = sourceLabel.includes("argon")
      ? "argon"
      : sourceLabel.includes("gemini")
        ? "gemini"
        : "gptClaude";
    const label =
      key === "argon" ? "Argon" : key === "gemini" ? "Gemini" : "Other";
    return [{ key, label, buckets }];
  });
}

function getAntigravityWindowOrder(window?: string): number {
  if (window === "5h") return 0;
  if (window === "weekly") return 1;
  return 2;
}

function selectAntigravityStatusBucket(
  buckets: AntigravityQuotaBucket[],
): AntigravityQuotaBucket {
  const fiveHour = buckets.find((bucket) => bucket.window === "5h");
  const weekly = buckets.find((bucket) => bucket.window === "weekly");

  if (
    weekly &&
    (getAntigravityRemainingPercent(weekly) === 0 || fiveHour?.disabled)
  ) {
    return weekly;
  }

  return fiveHour ?? weekly ?? buckets[0];
}

function antigravityStatusText(
  icon: string,
  label: string,
  buckets: AntigravityQuotaBucket[],
  settings: DisplaySettings,
): string {
  const iconOnly = settings.statusBarStyle === "icon";
  const prefix = settings.showIcons || iconOnly ? `${icon} ` : "";
  if (iconOnly) return prefix.trim();

  const title = settings.statusBarStyle === "full" ? `${label} ` : "";
  const bucket = selectAntigravityStatusBucket(buckets);
  const resetTime = settings.showResetTime
    ? ` · ${formatRemainingTime(getAntigravityResetTimestamp(bucket.resetTime))}`
    : "";
  return `${prefix}${title}%${getAntigravityRemainingPercent(bucket)}${resetTime}`;
}

function getAntigravityRemainingPercent(
  bucket: AntigravityQuotaBucket,
): number {
  const fraction = bucket.remainingFraction ?? 0;
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

function getAntigravityResetTimestamp(resetTime?: string): number | undefined {
  if (!resetTime) return undefined;
  const resetDate = new Date(resetTime);
  return Number.isFinite(resetDate.getTime())
    ? Math.floor(resetDate.getTime() / 1000)
    : undefined;
}

function formatWindowLabel(durationMins: number): string {
  if (durationMins <= 0) return "Limit";
  if (durationMins <= 300) return "5-hour";
  if (durationMins >= 10080) return "Week";
  if (durationMins >= 1440) return "Day";
  return `${Math.round(durationMins / 60)} hours`;
}

function formatWindow(window: RenderedWindow): string {
  const resetText = window.resetsAt
    ? ` · ${formatRemainingTime(window.resetsAt)} remaining · resets ${new Date(window.resetsAt * 1000).toLocaleString("en-US")}`
    : "";
  return `${window.label}: ${window.remainingPercent}% remaining${resetText}`;
}

function formatRemainingTime(resetsAt?: number): string {
  if (!resetsAt) return "No reset time";

  const minutesRemaining = Math.max(
    0,
    Math.ceil((resetsAt * 1000 - Date.now()) / 60_000),
  );
  const days = Math.floor(minutesRemaining / 1440);
  const hours = Math.floor((minutesRemaining % 1440) / 60);
  const minutes = minutesRemaining % 60;

  if (minutesRemaining > 1440) return `${days}d`;
  if (minutesRemaining > 600) return `${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

const STATUS_COLORS = {
  yellow: "#A58B36",
  orange: "#B66D35",
  red: "#B6535B",
} as const;

function getStatusBarColor(remainingPercent: number): string | undefined {
  if (!getDisplaySettings().colorize) return undefined;
  if (remainingPercent < RED_REMAINING_PERCENT) {
    return STATUS_COLORS.red;
  }
  if (remainingPercent < ORANGE_REMAINING_PERCENT) {
    return STATUS_COLORS.orange;
  }
  if (remainingPercent < YELLOW_REMAINING_PERCENT) {
    return STATUS_COLORS.yellow;
  }
  return undefined;
}

function readRateLimits(): Promise<RateLimitResponse> {
  return appServerRequest<RateLimitResponse>("account/rateLimits/read", {});
}

function readClaudeUsage(): Promise<ClaudeUsageResponse> {
  const configDirectory =
    process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const credentialsPath = join(configDirectory, ".credentials.json");
  let accessToken: string | undefined;
  try {
    const credentials: unknown = JSON.parse(
      readFileSync(credentialsPath, "utf8"),
    );
    if (
      typeof credentials === "object" &&
      credentials !== null &&
      "claudeAiOauth" in credentials
    ) {
      const oauth = credentials.claudeAiOauth;
      if (
        typeof oauth === "object" &&
        oauth !== null &&
        "accessToken" in oauth &&
        typeof oauth.accessToken === "string"
      ) {
        accessToken = oauth.accessToken;
      }
    }
  } catch {
    throw new Error(
      "Claude subscription session not found. Sign in to Claude Code with your Claude account.",
    );
  }

  if (!accessToken) {
    throw new Error(
      "Claude subscription session not found. Sign in to Claude Code with a Claude Pro or Max account.",
    );
  }

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "api.anthropic.com",
        path: CLAUDE_USAGE_API_PATH,
        method: "GET",
        timeout: CLAUDE_USAGE_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
        },
      },
      (response) => {
        let rawBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (rawBody += chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            const detail =
              response.statusCode === 401
                ? "Claude subscription session expired. Sign in to Claude Code again."
                : `Anthropic usage service returned HTTP ${response.statusCode}.`;
            reject(new Error(detail));
            return;
          }
          try {
            resolve(JSON.parse(rawBody) as ClaudeUsageResponse);
          } catch {
            reject(new Error("Could not read the Claude usage response."));
          }
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(
        new Error("Claude usage service timed out."),
      );
    });
    request.end();
  });
}

async function fetchAntigravityQuota(): Promise<AntigravityQuotaResponse> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_CONNECTION_SCRIPT],
    {
      timeout: ANTIGRAVITY_API_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    },
  );
  const parsed: unknown = JSON.parse(stdout.trim());
  const connections = Array.isArray(parsed)
    ? (parsed as AntigravityConnection[])
    : [parsed as AntigravityConnection];
  if (connections.length === 0) {
    throw new Error(
      "Antigravity language server was not found or its quota service is unavailable.",
    );
  }

  let lastError: Error | undefined;
  for (const connection of connections) {
    const ports = Array.isArray(connection.ports)
      ? connection.ports
      : [connection.ports];
    for (const port of [...ports].sort((left, right) => left - right)) {
      for (const protocol of ["https", "http"] as const) {
        try {
          const response = await requestAntigravityQuota(
            port,
            connection.csrfToken,
            protocol,
          );
          const hasUsableGroups = (response.response?.groups ?? []).some(
            (group) =>
              (group.buckets ?? []).some(
                (bucket) => typeof bucket.remainingFraction === "number",
              ),
          );
          if (hasUsableGroups) {
            try {
              const identity = await requestAntigravityQuota<
                Pick<AntigravityQuotaResponse, "userStatus">
              >(
                port,
                connection.csrfToken,
                protocol,
                "/exa.language_server_pb.LanguageServerService/GetUserStatus",
              );
              response.userStatus = identity.userStatus;
            } catch {
              // Quotas remain usable when the local account endpoint is unavailable.
            }
            return response;
          }
          lastError = new Error(
            "No available limits were found in the Antigravity quota response.",
          );
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }
    }
  }
  throw (
    lastError ?? new Error("Could not connect to the local Antigravity quota service.")
  );
}

function requestAntigravityQuota<T = AntigravityQuotaResponse>(
  port: number,
  csrfToken: string,
  protocol: "http" | "https",
  path = ANTIGRAVITY_USAGE_API_PATH,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      metadata: {
        ideName: "antigravity",
        extensionName: "antigravity",
        locale: "tr",
      },
    });
    const transport = protocol === "https" ? https : http;
    const request = transport.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        rejectUnauthorized: false,
        timeout: ANTIGRAVITY_API_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": csrfToken,
        },
      },
      (response) => {
        let rawBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (rawBody += chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `Local Antigravity service returned HTTP ${response.statusCode}.`,
              ),
            );
            return;
          }
          try {
            const parsed: unknown = JSON.parse(rawBody);
            if (typeof parsed !== "object" || parsed === null) {
              reject(
                new Error("Antigravity quota response has an unexpected format."),
              );
              return;
            }
            resolve(parsed as T);
          } catch {
            reject(new Error("Could not read the Antigravity quota response."));
          }
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(
        new Error("Antigravity quota service timed out."),
      );
    });
    request.end(body);
  });
}

function consumeResetCredit(
  idempotencyKey: string,
): Promise<ResetCreditConsumeResponse> {
  return appServerRequest<ResetCreditConsumeResponse>(
    "account/rateLimitResetCredit/consume",
    { idempotencyKey },
  );
}

function appServerRequest<T>(
  method: string,
  params: object,
  env?: NodeJS.ProcessEnv,
): Promise<T> {
  const executable = resolveCodexExecutable();
  return new Promise<T>((resolve, reject) => {
    const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;

    const finish = (error?: Error, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("Codex app server did not respond."));
    };

    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    };

    const timeout = setTimeout(
      () => finish(new Error("Codex app server timed out.")),
      APP_SERVER_TIMEOUT_MS,
    );

    child.once("error", (error) => {
      finish(new Error(`Could not start Codex CLI: ${error.message}`));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer = `${stderrBuffer}${chunk}`.slice(-2000);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf("\n");
        if (!line) continue;

        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          finish(new Error("Codex app server returned an invalid response."));
          return;
        }

        if (message.id === 1) {
          if (message.error) {
            finish(
              new Error(
                message.error.message ?? "Could not start the Codex session.",
              ),
            );
            return;
          }
          send({ method: "initialized", params: {} });
          send({ id: 2, method, params });
        } else if (message.id === 2) {
          if (message.error) {
            finish(
              new Error(
                message.error.message ??
                  (stderrBuffer.trim() || "Limit request failed."),
              ),
            );
            return;
          }
          finish(undefined, message.result as T);
          return;
        }
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: CLIENT_INFO, capabilities: {} },
    });
  });
}

function resolveCodexExecutable(): string {
  const configuredPath = vscode.workspace
    .getConfiguration("codexUsage")
    .get<string>("codexExecutable", "codex")
    .trim();

  if (process.platform !== "win32") return configuredPath;

  if (isAbsolute(configuredPath)) {
    if (isFile(configuredPath)) return configuredPath;
    throw new Error(`Codex CLI executable not found: ${configuredPath}`);
  }

  const executableName =
    configuredPath.toLowerCase() === "codex"
      ? "codex.exe"
      : configuredPath.toLowerCase().endsWith(".exe")
        ? configuredPath
        : `${configuredPath}.exe`;

  const environmentPath = process.env.CODEX_CLI_PATH;
  if (environmentPath && isFile(environmentPath)) return environmentPath;

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, executableName);
    if (isFile(candidate)) return candidate;
  }

  if (configuredPath.toLowerCase() === "codex") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const installDirectory = join(localAppData, "OpenAI", "Codex", "bin");
      try {
        const installedExecutables = readdirSync(installDirectory, {
          withFileTypes: true,
        })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(installDirectory, entry.name, "codex.exe"))
          .filter(isFile)
          .sort(
            (left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs,
          );
        if (installedExecutables.length > 0) return installedExecutables[0];
      } catch {
        // The Codex app may use another installation location.
      }
    }
  }

  throw new Error(
    "Codex CLI not found. Set the full path to codex.exe in the codexUsage.codexExecutable setting.",
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
