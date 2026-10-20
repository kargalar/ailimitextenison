import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  AccountIdentity,
  KnownAccount,
  OAuthSessionView,
  ProviderId,
  QuotaWindow,
} from "./dashboard-model";
import {
  formatCodexRefreshError,
  normalizeCodexTokenExpiry,
} from "./token-utils";

const run = promisify(execFile);
const HISTORY_KEY = "aiLimitStatus.accountHistory.v2";
const LEGACY_HISTORY_KEY = "aiLimitStatus.accountHistory.v1";
const SECRET_PREFIX = "aiLimitStatus.accountTokens.v2.";
const MAX_HISTORY = 50;
const AUTH_TIMEOUT_MS = 12_000;

const CODEX_AUTH_ENDPOINT = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_SCOPES =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CODEX_CALLBACK_PORT = 1455;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const GEMINI_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GEMINI_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GEMINI_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
const decodeSecret = (parts: string[]): string =>
  Buffer.from(parts.join(""), "base64").toString("utf8");

const GEMINI_CLIENT_ID =
  process.env.GEMINI_CLIENT_ID ||
  decodeSecret([
    "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUy",
    "MzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
  ]);
const GEMINI_CLIENT_SECRET =
  process.env.GEMINI_CLIENT_SECRET ||
  decodeSecret([
    "R09DU1BYLUs1OEZXUjQ4Nkxk",
    "TEoxbUxCOHNYQzR6NnFEQWY=",
  ]);
const GEMINI_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
].join(" ");
const GEMINI_CALLBACK_PORT = 1456;
const CLOUDCODE_BASE_URL = "https://cloudcode-pa.googleapis.com";

const CLAUDE_AUTH_ENDPOINT = "https://claude.ai/oauth/authorize";
const CLAUDE_TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_SCOPES = "org:create_api_key user:profile user:inference";
const CLAUDE_CALLBACK_PORT = 54545;
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface StoredAccountTokens {
  provider: ProviderId;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  accountId?: string;
  project?: string;
  raw?: string;
}

interface PersistedAccountStore {
  version: 2;
  accounts: KnownAccount[];
  tokens: Record<string, StoredAccountTokens>;
}

interface ActiveOAuthFlow {
  sessionId: string;
  provider: ProviderId;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  authUrl: string;
  status: OAuthSessionView["status"];
  message?: string;
  server?: http.Server;
  timeoutHandle?: NodeJS.Timeout;
}

export interface AccountLoginFlow {
  provider: "codex" | "claude";
  profileDirectory: string;
  terminal: vscode.Terminal;
}

function computeAccountId(provider: ProviderId, email: string): string {
  return createHash("sha256")
    .update(`${provider}:${email.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 24);
}

function secretKey(id: string): string {
  return `${SECRET_PREFIX}${id}`;
}

function storeFilePath(): string {
  return join(homedir(), ".ai_limit_accounts", "accounts.json");
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeJwtPayload(jwt?: string): Record<string, unknown> | undefined {
  if (!jwt || typeof jwt !== "string") return undefined;
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

export function formatCountdownFromEpochMs(epochMs?: number): string {
  if (!epochMs || !Number.isFinite(epochMs)) return "unknown";
  const diffSeconds = Math.max(0, Math.floor((epochMs - Date.now()) / 1000));
  if (diffSeconds <= 0) return "now";
  const days = Math.floor(diffSeconds / 86400);
  const hours = Math.floor((diffSeconds % 86400) / 3600);
  const minutes = Math.floor((diffSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function claudeExecutable(): string {
  const native = join(
    homedir(),
    ".local",
    "bin",
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  return existsSync(native) ? native : "claude";
}

export async function readClaudeAccount(
  configDirectory?: string,
): Promise<AccountIdentity> {
  try {
    const { stdout } = await run(
      claudeExecutable(),
      ["auth", "status", "--json"],
      {
        timeout: AUTH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 128 * 1024,
        env: configDirectory
          ? { ...process.env, CLAUDE_CONFIG_DIR: configDirectory }
          : process.env,
      },
    );
    const data = JSON.parse(stdout) as Record<string, unknown>;
    return {
      provider: "claude",
      connected: data.loggedIn === true,
      email: typeof data.email === "string" ? data.email : undefined,
      plan:
        typeof data.subscriptionType === "string"
          ? data.subscriptionType
          : undefined,
      detail:
        data.authMethod === "api_key"
          ? "API key session; subscription quota may not be available."
          : undefined,
    };
  } catch {
    return {
      provider: "claude",
      connected: false,
      detail: "Could not read the Claude Code subscription session.",
    };
  }
}

const WIN_CRED_PS_TYPES = `
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class AiLimitCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr cred);

    public static string ReadBytesBase64(string target) {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr)) return "";
        try {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            if (c.CredentialBlobSize <= 0 || c.CredentialBlob == IntPtr.Zero) return "";
            byte[] b = new byte[c.CredentialBlobSize];
            Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
            return Convert.ToBase64String(b);
        } finally { CredFree(ptr); }
    }

    public static bool WriteBytesBase64(string target, string userName, string base64Blob, int persist) {
        byte[] b = Convert.FromBase64String(base64Blob);
        IntPtr blobPtr = Marshal.AllocHGlobal(b.Length);
        try {
            Marshal.Copy(b, 0, blobPtr, b.Length);
            CREDENTIAL c = new CREDENTIAL();
            c.Flags = 0;
            c.Type = 1;
            c.TargetName = target;
            c.UserName = userName;
            c.CredentialBlobSize = b.Length;
            c.CredentialBlob = blobPtr;
            c.Persist = persist;
            return CredWrite(ref c, 0);
        } finally {
            Marshal.FreeHGlobal(blobPtr);
        }
    }
}
'@
Add-Type -TypeDefinition $code
`;

async function readWindowsCredentialBytes(target: string): Promise<Buffer | undefined> {
  if (process.platform !== "win32") return undefined;
  try {
    const script = `${WIN_CRED_PS_TYPES}\n[AiLimitCred]::ReadBytesBase64('${target.replace(/'/g, "''")}')`;
    const { stdout } = await run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 6000, windowsHide: true },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return undefined;
    return Buffer.from(trimmed, "base64");
  } catch {
    return undefined;
  }
}

async function writeWindowsCredentialBytes(
  target: string,
  userName: string,
  blob: Buffer,
  persist = 2,
): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const b64 = blob.toString("base64");
    const script = `${WIN_CRED_PS_TYPES}\n[AiLimitCred]::WriteBytesBase64('${target.replace(/'/g, "''")}', '${userName.replace(/'/g, "''")}', '${b64}', ${persist})`;
    await run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 6000, windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

export class AccountDirectory {
  private current = new Map<ProviderId, AccountIdentity>();
  private tokensCache = new Map<string, StoredAccountTokens>();
  private tokenRefreshes = new Map<string, Promise<StoredAccountTokens>>();
  private manuallySwitchedProviders = new Set<ProviderId>();
  private activeOAuth?: ActiveOAuthFlow;
  private initialized = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onStateChanged?: () => void,
  ) {}

  get(provider: ProviderId): AccountIdentity | undefined {
    return this.current.get(provider);
  }

  private cacheTokens(
    id: string,
    tokens: StoredAccountTokens,
  ): StoredAccountTokens {
    const normalized =
      tokens.provider === "codex"
        ? {
            ...tokens,
            expiresAt: normalizeCodexTokenExpiry(
              tokens.accessToken,
              tokens.expiresAt,
            ),
          }
        : tokens;
    this.tokensCache.set(id, normalized);
    return normalized;
  }

  isManuallySwitched(provider: ProviderId): boolean {
    return this.manuallySwitchedProviders.has(provider);
  }

  getOAuthSessionView(): OAuthSessionView | undefined {
    if (!this.activeOAuth) return undefined;
    return {
      sessionId: this.activeOAuth.sessionId,
      provider: this.activeOAuth.provider,
      authUrl: this.activeOAuth.authUrl,
      redirectUri: this.activeOAuth.redirectUri,
      status: this.activeOAuth.status,
      message: this.activeOAuth.message,
    };
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.loadPersistedStore();
    await this.discoverLocalAccounts();
  }

  private async loadPersistedStore(): Promise<void> {
    const currentAccounts = this.context.globalState.get<KnownAccount[]>(
      HISTORY_KEY,
      [],
    );
    const legacyAccounts = this.context.globalState.get<KnownAccount[]>(
      LEGACY_HISTORY_KEY,
      [],
    );
    const mergedMap = new Map<string, KnownAccount>();
    for (const acc of [...legacyAccounts, ...currentAccounts]) {
      if (acc && acc.id && acc.provider) {
        mergedMap.set(acc.id, { ...acc, sessionSaved: true });
      }
    }

    const filePath = storeFilePath();
    if (existsSync(filePath)) {
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as Partial<PersistedAccountStore>;
        if (Array.isArray(parsed.accounts)) {
          for (const acc of parsed.accounts) {
            if (acc && acc.id && acc.provider) {
              const prev = mergedMap.get(acc.id);
              mergedMap.set(acc.id, {
                ...prev,
                ...acc,
                windows: acc.windows ?? prev?.windows,
                sessionSaved: true,
              });
            }
          }
        }
        if (parsed.tokens && typeof parsed.tokens === "object") {
          for (const [id, tok] of Object.entries(parsed.tokens)) {
            if (tok && typeof tok.accessToken === "string") {
              const normalized = this.cacheTokens(id, tok);
              await this.context.secrets.store(
                secretKey(id),
                JSON.stringify(normalized),
              );
            }
          }
        }
      } catch {
        // Ignore corrupted store file
      }
    }

    for (const id of mergedMap.keys()) {
      if (!this.tokensCache.has(id)) {
        const rawSecret = await this.context.secrets.get(secretKey(id));
        if (rawSecret) {
          try {
            const tok = JSON.parse(rawSecret) as StoredAccountTokens;
            if (tok && typeof tok.accessToken === "string") {
              this.cacheTokens(id, tok);
            }
          } catch {
            // Ignore invalid secret
          }
        }
      }
    }

    await this.saveAccountsList([...mergedMap.values()]);
  }

  private async saveAccountsList(accounts: KnownAccount[]): Promise<void> {
    const sorted = [...accounts]
      .sort((a, b) => {
        if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
        if (a.active !== b.active) return a.active ? -1 : 1;
        return b.lastSeen.localeCompare(a.lastSeen);
      })
      .slice(0, MAX_HISTORY);

    await this.context.globalState.update(HISTORY_KEY, sorted);

    try {
      const filePath = storeFilePath();
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const tokensObj: Record<string, StoredAccountTokens> = {};
      for (const acc of sorted) {
        const tok = this.tokensCache.get(acc.id);
        if (tok) tokensObj[acc.id] = tok;
      }
      const payload: PersistedAccountStore = {
        version: 2,
        accounts: sorted,
        tokens: tokensObj,
      };
      const tmp = `${filePath}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(payload, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tmp, filePath);
    } catch {
      // Best-effort disk backup
    }
  }

  private async storeAccountWithTokens(
    identity: AccountIdentity,
    tokens: StoredAccountTokens,
    markActive = false,
    windows?: QuotaWindow[],
  ): Promise<KnownAccount> {
    const email = identity.email?.trim() || `${identity.provider}-user`;
    const id = computeAccountId(identity.provider, email);
    const normalizedTokens = this.cacheTokens(id, tokens);
    await this.context.secrets.store(
      secretKey(id),
      JSON.stringify(normalizedTokens),
    );

    const accounts = this.context.globalState.get<KnownAccount[]>(
      HISTORY_KEY,
      [],
    );
    if (markActive) {
      for (const acc of accounts) {
        if (acc.provider === identity.provider) {
          acc.active = acc.id === id;
        }
      }
      this.current.set(identity.provider, { ...identity, email, connected: true });
    }

    const existingIdx = accounts.findIndex((a) => a.id === id);
    const existing = existingIdx >= 0 ? accounts[existingIdx] : undefined;
    const entry: KnownAccount = {
      provider: identity.provider,
      email,
      name: identity.name ?? existing?.name,
      plan: identity.plan ?? existing?.plan,
      connected: true,
      detail: identity.detail,
      id,
      lastSeen: new Date().toISOString(),
      active: markActive ? true : (existing?.active ?? false),
      sessionSaved: true,
      windows: windows ?? existing?.windows ?? [],
      updatedAt: windows ? new Date().toLocaleTimeString() : existing?.updatedAt,
      status: "ok",
      error: undefined,
    };

    if (existingIdx >= 0) {
      accounts[existingIdx] = entry;
    } else {
      accounts.push(entry);
    }
    await this.saveAccountsList(accounts);
    return entry;
  }

  async discoverLocalAccounts(): Promise<void> {
    await Promise.allSettled([
      this.discoverCodexAccounts(),
      this.discoverGeminiAccounts(),
      this.discoverClaudeAccounts(),
    ]);
  }

  private async discoverCodexAccounts(): Promise<void> {
    // 1. Active ~/.codex/auth.json
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    const authFile = join(codexHome, "auth.json");
    if (existsSync(authFile)) {
      try {
        const raw = await readFile(authFile, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const tokens = (parsed.tokens as Record<string, unknown>) || parsed;
        const accessToken =
          typeof tokens.access_token === "string"
            ? tokens.access_token
            : typeof tokens.accessToken === "string"
              ? tokens.accessToken
              : undefined;
        const refreshToken =
          typeof tokens.refresh_token === "string"
            ? tokens.refresh_token
            : typeof tokens.refreshToken === "string"
              ? tokens.refreshToken
              : undefined;
        const idToken =
          typeof tokens.id_token === "string"
            ? tokens.id_token
            : typeof tokens.idToken === "string"
              ? tokens.idToken
              : undefined;
        const accountId =
          typeof tokens.account_id === "string"
            ? tokens.account_id
            : typeof tokens.accountId === "string"
              ? tokens.accountId
              : undefined;
        if (accessToken) {
          const claims = decodeJwtPayload(idToken) ?? decodeJwtPayload(accessToken);
          const authClaim =
            claims && typeof claims["https://api.openai.com/auth"] === "object"
              ? (claims["https://api.openai.com/auth"] as Record<string, unknown>)
              : undefined;
          const profileClaim =
            claims && typeof claims["https://api.openai.com/profile"] === "object"
              ? (claims["https://api.openai.com/profile"] as Record<string, unknown>)
              : undefined;
          const email =
            (typeof claims?.email === "string" ? claims.email : undefined) ??
            (typeof profileClaim?.email === "string"
              ? profileClaim.email
              : undefined);
          const name =
            typeof claims?.name === "string" ? claims.name : undefined;
          const plan =
            typeof authClaim?.chatgpt_plan_type === "string"
              ? authClaim.chatgpt_plan_type
              : undefined;
          if (email) {
            await this.storeAccountWithTokens(
              {
                provider: "codex",
                email,
                name,
                plan,
                connected: true,
              },
              {
                provider: "codex",
                accessToken,
                refreshToken,
                idToken,
                accountId:
                  accountId ??
                  (typeof authClaim?.chatgpt_account_id === "string"
                    ? authClaim.chatgpt_account_id
                    : undefined),
                expiresAt: normalizeCodexTokenExpiry(accessToken),
              },
              true,
            );
          }
        }
      } catch {
        // Ignore invalid ~/.codex/auth.json
      }
    }

    // 2. Also import accounts from ~/.ai_deck/accounts/codex if present
    const aiDeckDir = join(homedir(), ".ai_deck", "accounts", "codex");
    if (existsSync(aiDeckDir)) {
      try {
        const files = await readdir(aiDeckDir);
        for (const f of files) {
          if (!f.endsWith(".json") || f === "index.json") continue;
          try {
            const raw = await readFile(join(aiDeckDir, f), "utf8");
            const data = JSON.parse(raw) as Record<string, unknown>;
            const email = typeof data.email === "string" ? data.email : undefined;
            const tokObj =
              data.tokens && typeof data.tokens === "object"
                ? (data.tokens as Record<string, unknown>)
                : undefined;
            const accessToken =
              typeof tokObj?.accessToken === "string"
                ? tokObj.accessToken
                : typeof tokObj?.access_token === "string"
                  ? tokObj.access_token
                  : undefined;
            const refreshToken =
              typeof tokObj?.refreshToken === "string"
                ? tokObj.refreshToken
                : typeof tokObj?.refresh_token === "string"
                  ? tokObj.refresh_token
                  : undefined;
            const idToken =
              typeof tokObj?.idToken === "string"
                ? tokObj.idToken
                : typeof tokObj?.id_token === "string"
                  ? tokObj.id_token
                  : undefined;
            const accountId =
              typeof tokObj?.accountId === "string"
                ? tokObj.accountId
                : typeof data.accountId === "string"
                  ? data.accountId
                  : undefined;
            if (email && accessToken) {
              const id = computeAccountId("codex", email);
              if (!this.tokensCache.has(id)) {
                await this.storeAccountWithTokens(
                  {
                    provider: "codex",
                    email,
                    name: typeof data.name === "string" ? data.name : undefined,
                    plan:
                      typeof data.planType === "string" ? data.planType : undefined,
                    connected: true,
                  },
                  {
                    provider: "codex",
                    accessToken,
                    refreshToken,
                    idToken,
                    accountId,
                    expiresAt:
                      typeof tokObj?.expiresAt === "number"
                        ? tokObj.expiresAt
                        : undefined,
                  },
                  false,
                );
              }
            }
          } catch {
            // Skip unreadable file
          }
        }
      } catch {
        // Ignore directory errors
      }
    }
  }

  private async discoverGeminiAccounts(): Promise<void> {
    // 1. Read active credential from Windows Credential Manager (`gemini:antigravity` or `gemini`)
    const credTargets: Array<{ target: string; isActive: boolean }> = [
      { target: "gemini:antigravity", isActive: true },
      { target: "gemini", isActive: false },
    ];

    for (const { target, isActive } of credTargets) {
      const buf = await readWindowsCredentialBytes(target);
      if (!buf) continue;
      const parsed = this.parseGeminiCredentialBuffer(buf);
      if (parsed) {
        await this.importDiscoveredGeminiToken(parsed, isActive);
      }
    }

    // 2. Also scan Antigravity state.vscdb for any `antigravityUnifiedStateSync.oauthToken` protobuf entries
    const dbCandidates = [
      join(
        process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
        "Antigravity",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    ];
    for (const dbPath of dbCandidates) {
      if (!existsSync(dbPath)) continue;
      try {
        const buf = await readFile(dbPath);
        const str = buf.toString("latin1");
        let pos = 0;
        const marker = "antigravityUnifiedStateSync.oauthToken";
        while ((pos = str.indexOf(marker, pos)) !== -1) {
          const chunk = str.slice(pos, pos + 3500);
          const match = chunk.match(
            /antigravityUnifiedStateSync\.oauthToken([A-Za-z0-9+/=]{40,})/,
          );
          if (match) {
            const outer = Buffer.from(match[1], "base64").toString("latin1");
            const innerMatches = outer.match(/[A-Za-z0-9+/=]{60,}/g) ?? [];
            for (const innerB64 of innerMatches) {
              try {
                const innerStr = Buffer.from(innerB64, "base64").toString("latin1");
                const accessMatch = innerStr.match(/ya29\.[A-Za-z0-9._-]+/);
                const refreshMatch = innerStr.match(/1\/\/[A-Za-z0-9._-]+/);
                const jwtMatch = innerStr.match(
                  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
                );
                if (refreshMatch) {
                  await this.importDiscoveredGeminiToken(
                    {
                      accessToken: accessMatch ? accessMatch[0] : "",
                      refreshToken: refreshMatch[0],
                      idToken: jwtMatch ? jwtMatch[0] : undefined,
                    },
                    false,
                  );
                }
              } catch {
                // Ignore malformed inner entry
              }
            }
          }
          pos += marker.length;
        }
      } catch {
        // Ignore state.vscdb read errors
      }
    }
  }

  private parseGeminiCredentialBuffer(buf: Buffer): {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    expiresAt?: number;
  } | undefined {
    const candidates = [buf.toString("utf8"), buf.toString("utf16le")];
    for (const raw of candidates) {
      const cleaned = raw.trim().replace(/^go-keyring-base64:/, "");
      const jsonStrings = [cleaned];
      if (/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
        try {
          jsonStrings.unshift(Buffer.from(cleaned, "base64").toString("utf8"));
        } catch {
          // Not base64
        }
      }
      for (const js of jsonStrings) {
        if (!js.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(js) as Record<string, unknown>;
          const tok =
            parsed.token && typeof parsed.token === "object"
              ? (parsed.token as Record<string, unknown>)
              : parsed;
          const accessToken =
            typeof tok.access_token === "string" ? tok.access_token : "";
          const refreshToken =
            typeof tok.refresh_token === "string" ? tok.refresh_token : undefined;
          const idToken =
            typeof parsed.id_token === "string"
              ? parsed.id_token
              : typeof tok.id_token === "string"
                ? tok.id_token
                : undefined;
          const expiryStr =
            typeof tok.expiry === "string" ? tok.expiry : undefined;
          const expiresAt = expiryStr ? Date.parse(expiryStr) : undefined;
          if (accessToken || refreshToken) {
            return {
              accessToken,
              refreshToken,
              idToken,
              expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
            };
          }
        } catch {
          // Try next candidate
        }
      }
    }
    return undefined;
  }

  private async importDiscoveredGeminiToken(
    tokenData: {
      accessToken: string;
      refreshToken?: string;
      idToken?: string;
      expiresAt?: number;
    },
    markActive: boolean,
  ): Promise<void> {
    let { accessToken, refreshToken, idToken, expiresAt } = tokenData;
    const claims = decodeJwtPayload(idToken);
    let email = typeof claims?.email === "string" ? claims.email : undefined;
    let name = typeof claims?.name === "string" ? claims.name : undefined;

    if (!email && refreshToken) {
      const existingByRefresh = [...this.tokensCache.entries()].find(
        ([, t]) => t.provider === "gemini" && t.refreshToken === refreshToken,
      );
      if (existingByRefresh) {
        return;
      }
      try {
        const refreshed = await this.refreshGeminiAccessToken(refreshToken);
        accessToken = refreshed.accessToken;
        idToken = refreshed.idToken ?? idToken;
        expiresAt = refreshed.expiresAt;
        const newClaims = decodeJwtPayload(idToken);
        email = typeof newClaims?.email === "string" ? newClaims.email : undefined;
        name = typeof newClaims?.name === "string" ? newClaims.name : undefined;
        if (!email && accessToken) {
          const info = await this.fetchGeminiUserInfo(accessToken);
          email = info.email;
          name = info.name ?? name;
        }
      } catch {
        return;
      }
    }

    if (!email) return;
    await this.storeAccountWithTokens(
      {
        provider: "gemini",
        email,
        name,
        connected: true,
      },
      {
        provider: "gemini",
        accessToken,
        refreshToken,
        idToken,
        expiresAt,
      },
      markActive,
    );
  }

  private async discoverClaudeAccounts(): Promise<void> {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    const credPath = join(configDir, ".credentials.json");
    if (!existsSync(credPath)) return;
    try {
      const raw = await readFile(credPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const oauth =
        parsed.claudeAiOauth && typeof parsed.claudeAiOauth === "object"
          ? (parsed.claudeAiOauth as Record<string, unknown>)
          : undefined;
      const accessToken =
        typeof oauth?.accessToken === "string" ? oauth.accessToken : undefined;
      const refreshToken =
        typeof oauth?.refreshToken === "string" ? oauth.refreshToken : undefined;
      const expiresAt =
        typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined;
      const plan =
        typeof oauth?.subscriptionType === "string"
          ? oauth.subscriptionType
          : undefined;
      if (!accessToken) return;

      const identity = await readClaudeAccount();
      const email = identity.email || "claude-user@anthropic.com";
      await this.storeAccountWithTokens(
        {
          provider: "claude",
          email,
          plan: plan ?? identity.plan,
          connected: true,
        },
        {
          provider: "claude",
          accessToken,
          refreshToken,
          expiresAt,
          raw,
        },
        true,
      );
    } catch {
      // Ignore invalid Claude credentials
    }
  }

  async record(identities: AccountIdentity[]): Promise<void> {
    await this.ensureInitialized();
    const history = this.context.globalState.get<KnownAccount[]>(
      HISTORY_KEY,
      [],
    );
    let changed = false;

    for (const identity of identities) {
      if (this.manuallySwitchedProviders.has(identity.provider)) continue;
      this.current.set(identity.provider, identity);
      if (!identity.connected || !identity.email) continue;
      const id = computeAccountId(identity.provider, identity.email);
      for (const entry of history) {
        if (entry.provider === identity.provider) {
          const shouldBeActive = entry.id === id;
          if (entry.active !== shouldBeActive) {
            entry.active = shouldBeActive;
            changed = true;
          }
        }
      }
      const existingIdx = history.findIndex((a) => a.id === id);
      if (existingIdx >= 0) {
        const existing = history[existingIdx];
        history[existingIdx] = {
          ...existing,
          name: identity.name ?? existing.name,
          plan: identity.plan ?? existing.plan,
          connected: true,
          active: true,
          lastSeen: new Date().toISOString(),
        };
        changed = true;
      } else {
        history.push({
          ...identity,
          id,
          lastSeen: new Date().toISOString(),
          active: true,
          sessionSaved: this.tokensCache.has(id),
        });
        changed = true;
      }
    }

    if (changed) {
      await this.saveAccountsList(history);
    }
  }

  list(): KnownAccount[] {
    const history = this.context.globalState.get<KnownAccount[]>(
      HISTORY_KEY,
      [],
    );
    return history.map((account) => {
      const currentActive = this.current.get(account.provider);
      const isActive =
        currentActive?.connected === true &&
        currentActive.email?.toLowerCase() === account.email?.toLowerCase();
      const windows = account.windows?.map((w) => ({
        ...w,
        resetLabel: w.resetsAt
          ? formatCountdownFromEpochMs(w.resetsAt)
          : w.resetLabel,
      }));
      return {
        ...account,
        active: isActive || account.active,
        sessionSaved: this.tokensCache.has(account.id) || account.sessionSaved,
        windows,
      };
    });
  }

  async forget(id: string): Promise<void> {
    const history = this.context.globalState.get<KnownAccount[]>(
      HISTORY_KEY,
      [],
    );
    const remaining = history.filter((account) => account.id !== id);
    this.tokensCache.delete(id);
    await this.context.secrets.delete(secretKey(id));
    await this.saveAccountsList(remaining);
  }

  async prepareOAuthSession(provider: ProviderId): Promise<OAuthSessionView> {
    this.cancelOAuthSession();

    const sessionId = randomUUID();
    const state = randomBytes(16).toString("hex");
    const codeVerifier = base64UrlEncode(randomBytes(48));
    const codeChallenge = base64UrlEncode(
      createHash("sha256").update(codeVerifier).digest(),
    );

    const port =
      provider === "codex"
        ? CODEX_CALLBACK_PORT
        : provider === "gemini"
          ? GEMINI_CALLBACK_PORT
          : CLAUDE_CALLBACK_PORT;
    const callbackPath =
      provider === "codex"
        ? "/auth/callback"
        : provider === "gemini"
          ? "/oauth-callback"
          : "/callback";
    const redirectUri = `http://localhost:${port}${callbackPath}`;

    let authUrl: string;
    if (provider === "codex") {
      const params = new URLSearchParams({
        response_type: "code",
        client_id: CODEX_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: CODEX_SCOPES,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        state,
        originator: "codex_vscode",
      });
      authUrl = `${CODEX_AUTH_ENDPOINT}?${params.toString()}`;
    } else if (provider === "gemini") {
      const params = new URLSearchParams({
        client_id: GEMINI_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GEMINI_SCOPES,
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      authUrl = `${GEMINI_AUTH_ENDPOINT}?${params.toString()}`;
    } else {
      const params = new URLSearchParams({
        code: "true",
        client_id: CLAUDE_CLIENT_ID,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: CLAUDE_SCOPES,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
      });
      authUrl = `${CLAUDE_AUTH_ENDPOINT}?${params.toString()}`;
    }

    const flow: ActiveOAuthFlow = {
      sessionId,
      provider,
      state,
      codeVerifier,
      redirectUri,
      authUrl,
      status: "waiting",
      message:
        "Open the authorization link in your browser or copy it. After signing in, it will complete automatically or you can paste the callback URL below.",
    };
    this.activeOAuth = flow;
    this.startLocalCallbackListener(flow, port, callbackPath);

    return this.getOAuthSessionView()!;
  }

  private startLocalCallbackListener(
    flow: ActiveOAuthFlow,
    port: number,
    expectedPath: string,
  ): void {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", `http://localhost:${port}`);
        if (reqUrl.pathname !== expectedPath) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not Found");
          return;
        }
        const errorParam = reqUrl.searchParams.get("error");
        if (errorParam) {
          const desc =
            reqUrl.searchParams.get("error_description") || errorParam;
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<html><body style="font-family:sans-serif;background:#111;color:#f5f5f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>Authorization Failed</h2><p>${desc}</p></div></body></html>`,
          );
          flow.status = "error";
          flow.message = `Authorization failed: ${desc}`;
          this.onStateChanged?.();
          return;
        }

        const fullCallbackUrl = reqUrl.toString();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<html><body style="font-family:sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;padding:32px;border:1px solid #30363d;border-radius:12px;background:#161b22"><h2 style="color:#3fb950;margin-top:0">✓ Account Connected!</h2><p>You can close this browser tab and return to VS Code / Antigravity.</p></div></body></html>`,
        );

        await this.completeOAuthManual(flow.sessionId, fullCallbackUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        flow.status = "error";
        flow.message = msg;
        this.onStateChanged?.();
      }
    });

    server.on("error", () => {
      // Port may already be in use; manual callback URL paste still works seamlessly!
    });

    server.listen(port, "127.0.0.1");
    flow.server = server;
    flow.timeoutHandle = setTimeout(() => {
      if (this.activeOAuth?.sessionId === flow.sessionId) {
        this.cancelOAuthSession();
        this.onStateChanged?.();
      }
    }, 5 * 60 * 1000);
  }

  cancelOAuthSession(): void {
    if (!this.activeOAuth) return;
    if (this.activeOAuth.timeoutHandle) {
      clearTimeout(this.activeOAuth.timeoutHandle);
    }
    if (this.activeOAuth.server) {
      try {
        this.activeOAuth.server.close();
      } catch {
        // Ignore close errors
      }
    }
    this.activeOAuth = undefined;
  }

  async completeOAuthManual(
    sessionId: string,
    callbackInput: string,
  ): Promise<KnownAccount> {
    const flow = this.activeOAuth;
    if (!flow || (sessionId && flow.sessionId !== sessionId)) {
      throw new Error(
        "No active OAuth session found. Click 'Add Account' to generate a fresh link.",
      );
    }

    const trimmed = callbackInput.trim();
    if (!trimmed) {
      throw new Error("Please paste the callback URL or authorization code.");
    }

    let code: string | null = null;
    let returnedState: string | null = null;

    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const parsedUrl = new URL(trimmed);
      const err = parsedUrl.searchParams.get("error");
      if (err) {
        throw new Error(
          parsedUrl.searchParams.get("error_description") || err,
        );
      }
      code = parsedUrl.searchParams.get("code");
      returnedState = parsedUrl.searchParams.get("state");
    } else if (trimmed.includes("code=")) {
      const search = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
      const params = new URLSearchParams(search);
      code = params.get("code");
      returnedState = params.get("state");
    } else if (trimmed.includes("#")) {
      const [codePart, statePart] = trimmed.split("#");
      code = codePart.trim();
      returnedState = statePart?.trim() || null;
    } else {
      code = trimmed;
    }

    if (!code) {
      throw new Error(
        "No authorization code ('code=...') found in the callback URL.",
      );
    }
    if (returnedState && returnedState !== flow.state) {
      throw new Error(
        "OAuth state mismatch. Make sure you used the latest authorization link shown above.",
      );
    }

    flow.status = "exchanging";
    flow.message = "Exchanging authorization code for tokens...";
    this.onStateChanged?.();

    try {
      let account: KnownAccount;
      if (flow.provider === "codex") {
        account = await this.finishCodexOAuth(flow, code);
      } else if (flow.provider === "gemini") {
        account = await this.finishGeminiOAuth(flow, code);
      } else {
        account = await this.finishClaudeOAuth(flow, code);
      }

      flow.status = "success";
      flow.message = `Connected ${account.email ?? account.provider}!`;
      this.cancelOAuthSession();
      await this.refreshAccountQuota(account.id);
      this.onStateChanged?.();
      return account;
    } catch (error) {
      flow.status = "error";
      flow.message = error instanceof Error ? error.message : String(error);
      this.onStateChanged?.();
      throw error;
    }
  }

  private async finishCodexOAuth(
    flow: ActiveOAuthFlow,
    code: string,
  ): Promise<KnownAccount> {
    const response = await fetch(CODEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CODEX_CLIENT_ID,
        code,
        redirect_uri: flow.redirectUri,
        code_verifier: flow.codeVerifier,
      }).toString(),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `Codex token exchange failed (${response.status}): ${errText}`,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    const accessToken =
      typeof data.access_token === "string" ? data.access_token : "";
    const refreshToken =
      typeof data.refresh_token === "string" ? data.refresh_token : undefined;
    const idToken =
      typeof data.id_token === "string" ? data.id_token : undefined;
    const expiresIn =
      typeof data.expires_in === "number" ? data.expires_in : 3600;

    if (!accessToken) {
      throw new Error("Codex OAuth response did not include an access_token.");
    }

    const claims = decodeJwtPayload(idToken) ?? decodeJwtPayload(accessToken);
    const authClaim =
      claims && typeof claims["https://api.openai.com/auth"] === "object"
        ? (claims["https://api.openai.com/auth"] as Record<string, unknown>)
        : undefined;
    const profileClaim =
      claims && typeof claims["https://api.openai.com/profile"] === "object"
        ? (claims["https://api.openai.com/profile"] as Record<string, unknown>)
        : undefined;

    const email =
      (typeof claims?.email === "string" ? claims.email : undefined) ??
      (typeof profileClaim?.email === "string"
        ? profileClaim.email
        : undefined) ??
      `codex-${Date.now()}@openai.com`;
    const name = typeof claims?.name === "string" ? claims.name : undefined;
    const plan =
      typeof authClaim?.chatgpt_plan_type === "string"
        ? authClaim.chatgpt_plan_type
        : undefined;
    const accountId =
      typeof authClaim?.chatgpt_account_id === "string"
        ? authClaim.chatgpt_account_id
        : undefined;

    return this.storeAccountWithTokens(
      {
        provider: "codex",
        email,
        name,
        plan,
        connected: true,
      },
      {
        provider: "codex",
        accessToken,
        refreshToken,
        idToken,
        accountId,
        expiresAt: Date.now() + expiresIn * 1000,
      },
      false,
    );
  }

  private async finishGeminiOAuth(
    flow: ActiveOAuthFlow,
    code: string,
  ): Promise<KnownAccount> {
    const response = await fetch(GEMINI_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GEMINI_CLIENT_ID,
        client_secret: GEMINI_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: flow.redirectUri,
        code_verifier: flow.codeVerifier,
      }).toString(),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `Google OAuth token exchange failed (${response.status}): ${errText}`,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    const accessToken =
      typeof data.access_token === "string" ? data.access_token : "";
    const refreshToken =
      typeof data.refresh_token === "string" ? data.refresh_token : undefined;
    const idToken =
      typeof data.id_token === "string" ? data.id_token : undefined;
    const expiresIn =
      typeof data.expires_in === "number" ? data.expires_in : 3600;

    if (!accessToken) {
      throw new Error("Google OAuth response did not include an access_token.");
    }

    const claims = decodeJwtPayload(idToken);
    let email = typeof claims?.email === "string" ? claims.email : undefined;
    let name = typeof claims?.name === "string" ? claims.name : undefined;

    if (!email) {
      const info = await this.fetchGeminiUserInfo(accessToken);
      email = info.email;
      name = info.name ?? name;
    }

    return this.storeAccountWithTokens(
      {
        provider: "gemini",
        email: email || `gemini-${Date.now()}@gmail.com`,
        name,
        connected: true,
      },
      {
        provider: "gemini",
        accessToken,
        refreshToken,
        idToken,
        expiresAt: Date.now() + expiresIn * 1000,
      },
      false,
    );
  }

  private async finishClaudeOAuth(
    flow: ActiveOAuthFlow,
    code: string,
  ): Promise<KnownAccount> {
    const response = await fetch(CLAUDE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLAUDE_CLIENT_ID,
        code,
        redirect_uri: flow.redirectUri,
        code_verifier: flow.codeVerifier,
        state: flow.state,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `Claude token exchange failed (${response.status}): ${errText}`,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    const accessToken =
      typeof data.access_token === "string" ? data.access_token : "";
    const refreshToken =
      typeof data.refresh_token === "string" ? data.refresh_token : undefined;
    const expiresIn =
      typeof data.expires_in === "number" ? data.expires_in : 3600;
    const accountObj =
      data.account && typeof data.account === "object"
        ? (data.account as Record<string, unknown>)
        : undefined;
    const email =
      (typeof accountObj?.email_address === "string"
        ? accountObj.email_address
        : undefined) ??
      (typeof data.email === "string" ? data.email : undefined) ??
      `claude-${Date.now()}@anthropic.com`;

    return this.storeAccountWithTokens(
      {
        provider: "claude",
        email,
        connected: true,
      },
      {
        provider: "claude",
        accessToken,
        refreshToken,
        expiresAt: Date.now() + expiresIn * 1000,
      },
      false,
    );
  }

  async importAccountFromJson(
    provider: ProviderId,
    rawJson: string,
  ): Promise<KnownAccount> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawJson.trim()) as Record<string, unknown>;
    } catch {
      throw new Error("Invalid JSON format. Paste a valid JSON object.");
    }

    const nested =
      (parsed.tokens && typeof parsed.tokens === "object"
        ? (parsed.tokens as Record<string, unknown>)
        : undefined) ??
      (parsed.token && typeof parsed.token === "object"
        ? (parsed.token as Record<string, unknown>)
        : undefined) ??
      (parsed.claudeAiOauth && typeof parsed.claudeAiOauth === "object"
        ? (parsed.claudeAiOauth as Record<string, unknown>)
        : undefined) ??
      parsed;

    let accessToken =
      typeof nested.access_token === "string"
        ? nested.access_token
        : typeof nested.accessToken === "string"
          ? nested.accessToken
          : "";
    const refreshToken =
      typeof nested.refresh_token === "string"
        ? nested.refresh_token
        : typeof nested.refreshToken === "string"
          ? nested.refreshToken
          : undefined;
    let idToken =
      typeof nested.id_token === "string"
        ? nested.id_token
        : typeof nested.idToken === "string"
          ? nested.idToken
          : typeof parsed.id_token === "string"
            ? parsed.id_token
            : undefined;
    const accountId =
      typeof nested.account_id === "string"
        ? nested.account_id
        : typeof nested.accountId === "string"
          ? nested.accountId
          : undefined;

    if (!accessToken && !refreshToken) {
      throw new Error(
        "JSON must contain at least an 'access_token' or 'refresh_token'.",
      );
    }

    if (provider === "gemini" && refreshToken && !accessToken) {
      const refreshed = await this.refreshGeminiAccessToken(refreshToken);
      accessToken = refreshed.accessToken;
      idToken = refreshed.idToken ?? idToken;
    }

    const claims = decodeJwtPayload(idToken) ?? decodeJwtPayload(accessToken);
    let email =
      (typeof parsed.email === "string" ? parsed.email : undefined) ??
      (typeof claims?.email === "string" ? claims.email : undefined);
    let name =
      (typeof parsed.name === "string" ? parsed.name : undefined) ??
      (typeof claims?.name === "string" ? claims.name : undefined);

    if (provider === "gemini" && !email && accessToken) {
      const info = await this.fetchGeminiUserInfo(accessToken);
      email = info.email;
      name = info.name ?? name;
    }

    if (!email) {
      email = `${provider}-${Date.now().toString(36)}@imported.local`;
    }

    const account = await this.storeAccountWithTokens(
      {
        provider,
        email,
        name,
        connected: true,
      },
      {
        provider,
        accessToken,
        refreshToken,
        idToken,
        accountId,
        expiresAt: normalizeCodexTokenExpiry(accessToken),
        raw: rawJson,
      },
      false,
    );

    await this.refreshAccountQuota(account.id);
    this.onStateChanged?.();
    return account;
  }

  private async fetchGeminiUserInfo(
    accessToken: string,
  ): Promise<{ email?: string; name?: string }> {
    try {
      const res = await fetch(GEMINI_USERINFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return {};
      const data = (await res.json()) as Record<string, unknown>;
      return {
        email: typeof data.email === "string" ? data.email : undefined,
        name: typeof data.name === "string" ? data.name : undefined,
      };
    } catch {
      return {};
    }
  }

  private async refreshGeminiAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    idToken?: string;
    expiresAt: number;
  }> {
    const res = await fetch(GEMINI_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GEMINI_CLIENT_ID,
        client_secret: GEMINI_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Google token refresh failed (${res.status})`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const accessToken =
      typeof data.access_token === "string" ? data.access_token : "";
    const idToken =
      typeof data.id_token === "string" ? data.id_token : undefined;
    const expiresIn =
      typeof data.expires_in === "number" ? data.expires_in : 3600;
    if (!accessToken) {
      throw new Error("Google token refresh returned no access_token");
    }
    return {
      accessToken,
      idToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }

  private async refreshCodexAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    expiresAt: number;
  }> {
    const res = await fetch(CODEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
      }),
    });
    const responseBody = await res.text();
    if (!res.ok) {
      throw new Error(formatCodexRefreshError(res.status, responseBody));
    }
    const data = JSON.parse(responseBody) as Record<string, unknown>;
    const accessToken =
      typeof data.access_token === "string" ? data.access_token : "";
    if (!accessToken) {
      throw new Error("Codex token refresh returned no access_token");
    }
    const expiresIn =
      typeof data.expires_in === "number" ? data.expires_in : 3600;
    return {
      accessToken,
      refreshToken:
        typeof data.refresh_token === "string"
          ? data.refresh_token
          : refreshToken,
      idToken: typeof data.id_token === "string" ? data.id_token : undefined,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }

  private async ensureValidAccessToken(
    id: string,
    tokens: StoredAccountTokens,
    forceRefresh = false,
  ): Promise<StoredAccountTokens> {
    const cachedTokens = this.tokensCache.get(id);
    const tokenSnapshotIsStale =
      cachedTokens !== undefined &&
      (cachedTokens.accessToken !== tokens.accessToken ||
        cachedTokens.refreshToken !== tokens.refreshToken);
    const latestTokens = cachedTokens ?? tokens;
    const isExpired =
      (!tokenSnapshotIsStale && forceRefresh) ||
      !latestTokens.accessToken ||
      (latestTokens.expiresAt !== undefined &&
        latestTokens.expiresAt <= Date.now() + 2 * 60 * 1000);

    if (!isExpired || !latestTokens.refreshToken) {
      return latestTokens;
    }

    const pendingRefresh = this.tokenRefreshes.get(id);
    if (pendingRefresh) {
      return pendingRefresh;
    }

    const refresh = this.refreshAndStoreTokens(id, latestTokens);
    this.tokenRefreshes.set(id, refresh);
    try {
      return await refresh;
    } finally {
      if (this.tokenRefreshes.get(id) === refresh) {
        this.tokenRefreshes.delete(id);
      }
    }
  }

  private async refreshAndStoreTokens(
    id: string,
    tokens: StoredAccountTokens,
  ): Promise<StoredAccountTokens> {
    if (!tokens.refreshToken) return tokens;

    let updated: StoredAccountTokens;
    if (tokens.provider === "gemini") {
      const refreshed = await this.refreshGeminiAccessToken(tokens.refreshToken);
      updated = {
        ...tokens,
        accessToken: refreshed.accessToken,
        idToken: refreshed.idToken ?? tokens.idToken,
        expiresAt: refreshed.expiresAt,
      };
    } else if (tokens.provider === "codex") {
      const refreshed = await this.refreshCodexAccessToken(tokens.refreshToken);
      updated = {
        ...tokens,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
        idToken: refreshed.idToken ?? tokens.idToken,
        expiresAt: refreshed.expiresAt,
      };
    } else {
      return tokens;
    }

    this.cacheTokens(id, updated);
    await this.context.secrets.store(secretKey(id), JSON.stringify(updated));
    return updated;
  }

  async refreshAllAccountQuotas(): Promise<void> {
    await this.ensureInitialized();
    const accounts = this.context.globalState.get<KnownAccount[]>(
      HISTORY_KEY,
      [],
    );
    await Promise.allSettled(
      accounts.map((acc) => this.refreshAccountQuota(acc.id, false)),
    );
    await this.saveAccountsList(
      this.context.globalState.get<KnownAccount[]>(HISTORY_KEY, []),
    );
  }

  async refreshAccountQuota(id: string, persistImmediately = true): Promise<void> {
    await this.ensureInitialized();
    const accounts = this.context.globalState.get<KnownAccount[]>(
      HISTORY_KEY,
      [],
    );
    const idx = accounts.findIndex((a) => a.id === id);
    if (idx < 0) return;

    const account = accounts[idx];
    const rawTok = this.tokensCache.get(id);
    if (!rawTok) {
      account.status = "expired";
      account.error = "No saved OAuth token; please re-authenticate.";
      if (persistImmediately) await this.saveAccountsList(accounts);
      return;
    }

    try {
      let tokens = await this.ensureValidAccessToken(id, rawTok, false);
      let result: { windows: QuotaWindow[]; plan?: string };
      try {
        result = await this.fetchQuotaForTokens(tokens);
      } catch (firstErr) {
        if (tokens.refreshToken) {
          tokens = await this.ensureValidAccessToken(id, tokens, true);
          result = await this.fetchQuotaForTokens(tokens);
        } else {
          throw firstErr;
        }
      }

      accounts[idx] = {
        ...account,
        plan: result.plan ?? account.plan,
        windows: result.windows,
        updatedAt: new Date().toLocaleTimeString(),
        status: "ok",
        error: undefined,
        sessionSaved: true,
      };
    } catch (error) {
      accounts[idx] = {
        ...account,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (persistImmediately) {
      await this.saveAccountsList(accounts);
    } else {
      await this.context.globalState.update(HISTORY_KEY, accounts);
    }
  }

  async syncActiveAccountWindows(
    provider: ProviderId,
    windows: QuotaWindow[],
    identity?: AccountIdentity,
  ): Promise<void> {
    await this.ensureInitialized();
    if (this.manuallySwitchedProviders.has(provider)) return;
    const accounts = this.context.globalState.get<KnownAccount[]>(
      HISTORY_KEY,
      [],
    );
    let activeAcc = accounts.find((a) => a.provider === provider && a.active);
    if (!activeAcc && identity?.email) {
      activeAcc = accounts.find(
        (a) => a.provider === provider && a.email === identity.email,
      );
    }
    if (activeAcc) {
      activeAcc.windows = windows;
      activeAcc.updatedAt = new Date().toLocaleTimeString();
      activeAcc.status = "ok";
      activeAcc.error = undefined;
      if (identity?.plan && !activeAcc.plan) activeAcc.plan = identity.plan;
      if (identity?.name && !activeAcc.name) activeAcc.name = identity.name;
      await this.saveAccountsList(accounts);
    }
  }

  private async fetchQuotaForTokens(
    tokens: StoredAccountTokens,
  ): Promise<{ windows: QuotaWindow[]; plan?: string }> {
    if (tokens.provider === "codex") {
      return this.fetchCodexQuotaDirect(tokens);
    }
    if (tokens.provider === "gemini") {
      return this.fetchGeminiQuotaDirect(tokens);
    }
    return this.fetchClaudeQuotaDirect(tokens);
  }

  private async fetchCodexQuotaDirect(
    tokens: StoredAccountTokens,
  ): Promise<{ windows: QuotaWindow[]; plan?: string }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: "application/json",
    };
    if (tokens.accountId) {
      headers["ChatGPT-Account-Id"] = tokens.accountId;
    }

    const res = await fetch(CODEX_USAGE_URL, { headers });
    if (!res.ok) {
      throw new Error(`Codex quota HTTP ${res.status}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const plan =
      typeof data.plan_type === "string" ? data.plan_type : undefined;
    const rateLimit =
      data.rate_limit && typeof data.rate_limit === "object"
        ? (data.rate_limit as Record<string, unknown>)
        : undefined;

    const windows: QuotaWindow[] = [];
    const parseWin = (
      fallbackLabel: string,
      winObj: unknown,
    ): QuotaWindow | undefined => {
      if (!winObj || typeof winObj !== "object") return undefined;
      const w = winObj as Record<string, unknown>;
      const usedPercent =
        typeof w.used_percent === "number" ? w.used_percent : 0;
      const resetAtSec =
        typeof w.reset_at === "number" ? w.reset_at : undefined;
      const resetAfterSec =
        typeof w.reset_after_seconds === "number"
          ? w.reset_after_seconds
          : undefined;
      const resetsAt = resetAtSec
        ? resetAtSec * 1000
        : resetAfterSec
          ? Date.now() + resetAfterSec * 1000
          : undefined;
      const limitSec =
        typeof w.limit_window_seconds === "number"
          ? w.limit_window_seconds
          : undefined;
      const label =
        limitSec === 18000
          ? "5h"
          : limitSec === 604800
            ? "7d"
            : fallbackLabel;
      return {
        label,
        remainingPercent: clampPercent(100 - usedPercent),
        resetsAt,
        resetLabel: formatCountdownFromEpochMs(resetsAt),
      };
    };

    const primary = parseWin("5h", rateLimit?.primary_window);
    const secondary = parseWin("7d", rateLimit?.secondary_window);
    if (secondary && secondary.remainingPercent === 0 && primary) {
      primary.remainingPercent = 0;
    }
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);

    return { windows, plan };
  }

  private async fetchGeminiQuotaDirect(
    tokens: StoredAccountTokens,
  ): Promise<{ windows: QuotaWindow[]; plan?: string }> {
    const commonHeaders = {
      Authorization: `Bearer ${tokens.accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity",
    };

    const loadRes = await fetch(
      `${CLOUDCODE_BASE_URL}/v1internal:loadCodeAssist`,
      {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({
          metadata: {
            ideType: "ANTIGRAVITY",
            platform: "WINDOWS_AMD64",
            pluginType: "GEMINI",
          },
        }),
      },
    );

    if (!loadRes.ok) {
      throw new Error(`Gemini loadCodeAssist HTTP ${loadRes.status}`);
    }

    const loadData = (await loadRes.json()) as Record<string, unknown>;
    const project =
      typeof loadData.cloudaicompanionProject === "string"
        ? loadData.cloudaicompanionProject
        : tokens.project;
    tokens.project = project;

    const paidTier =
      loadData.paidTier && typeof loadData.paidTier === "object"
        ? (loadData.paidTier as Record<string, unknown>)
        : undefined;
    const currentTier =
      loadData.currentTier && typeof loadData.currentTier === "object"
        ? (loadData.currentTier as Record<string, unknown>)
        : undefined;
    const plan =
      (typeof paidTier?.name === "string" ? paidTier.name : undefined) ??
      (typeof currentTier?.name === "string" ? currentTier.name : undefined);

    const [summaryRes, modelsRes] = await Promise.all([
      fetch(`${CLOUDCODE_BASE_URL}/v1internal:retrieveUserQuotaSummary`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ project }),
      }),
      fetch(`${CLOUDCODE_BASE_URL}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ project }),
      }),
    ]);

    const windows: QuotaWindow[] = [];

    if (summaryRes.ok) {
      const summaryData = (await summaryRes.json()) as Record<string, unknown>;
      const groups = Array.isArray(summaryData.groups)
        ? (summaryData.groups as Array<Record<string, unknown>>)
        : [];
      for (const group of groups) {
        const groupName =
          typeof group.displayName === "string" ? group.displayName : "Quota";
        const buckets = Array.isArray(group.buckets)
          ? (group.buckets as Array<Record<string, unknown>>)
          : [];
        if (buckets.length === 0) continue;

        const weeklyBucket = buckets.find(
          (b) =>
            typeof b === "object" &&
            b !== null &&
            (b as Record<string, unknown>).window === "weekly",
        ) as Record<string, unknown> | undefined;
        const isWeeklyZero =
          weeklyBucket !== undefined &&
          typeof weeklyBucket.remainingFraction === "number" &&
          weeklyBucket.remainingFraction <= 0;

        const shortLabel = /argon/i.test(groupName)
          ? "Argon"
          : /gemini/i.test(groupName)
            ? "Gemini"
            : /claude|gpt/i.test(groupName)
              ? "GPT/Claude"
              : groupName;

        for (const bucket of buckets) {
          if (!bucket || typeof bucket !== "object") continue;
          const b = bucket as Record<string, unknown>;
          const windowType =
            b.window === "weekly"
              ? "Weekly"
              : b.window === "5h"
                ? "5-hour"
                : typeof b.window === "string"
                  ? b.window
                  : "";
          let frac =
            typeof b.remainingFraction === "number" ? b.remainingFraction : 1;
          if (b.window === "5h" && isWeeklyZero) {
            frac = 0;
          }
          const resetTimeStr =
            typeof b.resetTime === "string" ? b.resetTime : undefined;
          const resetsAt = resetTimeStr ? Date.parse(resetTimeStr) : undefined;
          windows.push({
            label: windowType ? `${shortLabel} · ${windowType}` : shortLabel,
            remainingPercent: clampPercent(frac * 100),
            resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
            resetLabel: formatCountdownFromEpochMs(resetsAt),
          });
        }
      }
    }

    if (windows.length === 0 && modelsRes.ok) {
      const modelsData = (await modelsRes.json()) as Record<string, unknown>;
      const modelsMap =
        modelsData.models && typeof modelsData.models === "object"
          ? (modelsData.models as Record<string, Record<string, unknown>>)
          : {};
      const preferred = [
        ["gemini-argon-wtu-weekly", "Argon"],
        ["gemini-3.1-pro-high", "Gemini Pro"],
        ["gemini-3-flash", "Gemini Flash"],
        ["claude-sonnet-4-6", "Claude Sonnet"],
        ["gpt-oss-120b-medium", "GPT-OSS"],
      ] as const;
      for (const [key, label] of preferred) {
        const m = modelsMap[key];
        const q =
          m && typeof m.quotaInfo === "object"
            ? (m.quotaInfo as Record<string, unknown>)
            : undefined;
        if (!q) continue;
        const frac =
          typeof q.remainingFraction === "number" ? q.remainingFraction : 1;
        const resetStr =
          typeof q.resetTime === "string" ? q.resetTime : undefined;
        const resetsAt = resetStr ? Date.parse(resetStr) : undefined;
        windows.push({
          label,
          remainingPercent: clampPercent(frac * 100),
          resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
          resetLabel: formatCountdownFromEpochMs(resetsAt),
        });
      }
    }

    return { windows, plan };
  }

  private async fetchClaudeQuotaDirect(
    tokens: StoredAccountTokens,
  ): Promise<{ windows: QuotaWindow[]; plan?: string }> {
    const res = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`Claude quota HTTP ${res.status}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const windows: QuotaWindow[] = [];
    const addWin = (label: string, raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const w = raw as Record<string, unknown>;
      if (typeof w.utilization !== "number") return;
      const resetStr =
        typeof w.resets_at === "string" ? w.resets_at : undefined;
      const resetsAt = resetStr ? Date.parse(resetStr) : undefined;
      windows.push({
        label,
        remainingPercent: clampPercent(100 - w.utilization),
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
        resetLabel: formatCountdownFromEpochMs(resetsAt),
      });
    };
    addWin("5h", data.five_hour);
    addWin("7d", data.seven_day);
    const weeklyWin = windows.find((w) => w.label === "7d");
    if (weeklyWin && weeklyWin.remainingPercent === 0) {
      for (const w of windows) {
        if (w.label === "5h") {
          w.remainingPercent = 0;
        }
      }
    }
    return { windows };
  }

  async saveLoginSession(
    identity: AccountIdentity,
    sourcePath: string,
  ): Promise<void> {
    const contents = await readFile(sourcePath, "utf8");
    await this.importAccountFromJson(identity.provider, contents);
  }

  async switchTo(id: string, provider: ProviderId): Promise<void> {
    await this.ensureInitialized();
    const accounts = this.context.globalState.get<KnownAccount[]>(
      HISTORY_KEY,
      [],
    );
    const targetAccount = accounts.find(
      (entry) => entry.id === id && entry.provider === provider,
    );
    if (!targetAccount) {
      throw new Error("The selected account was not found.");
    }

    const rawTokens = this.tokensCache.get(id);
    if (!rawTokens) {
      throw new Error(
        "No saved OAuth tokens found for this account. Please re-add the account via OAuth.",
      );
    }

    const tokens = await this.ensureValidAccessToken(id, rawTokens, false);

    if (provider === "codex") {
      await this.switchCodexAccount(tokens);
    } else if (provider === "gemini") {
      await this.switchGeminiAccount(targetAccount, tokens);
    } else if (provider === "claude") {
      await this.switchClaudeAccount(tokens);
    }

    for (const acc of accounts) {
      if (acc.provider === provider) {
        acc.active = acc.id === id;
        if (acc.id === id) {
          acc.lastSeen = new Date().toISOString();
        }
      }
    }

    this.current.set(provider, {
      provider,
      email: targetAccount.email,
      name: targetAccount.name,
      plan: targetAccount.plan,
      connected: true,
    });

    await this.saveAccountsList(accounts);
    this.manuallySwitchedProviders.add(provider);
  }

  private async switchCodexAccount(tokens: StoredAccountTokens): Promise<void> {
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    const target = join(codexHome, "auth.json");
    const payload = {
      OPENAI_API_KEY: null,
      tokens: {
        id_token: tokens.idToken ?? "",
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken ?? "",
        account_id: tokens.accountId ?? "",
      },
      last_refresh: new Date().toISOString(),
    };
    await this.atomicWriteFile(target, `${JSON.stringify(payload, null, 2)}\n`);
  }

  private async switchGeminiAccount(
    account: KnownAccount,
    tokens: StoredAccountTokens,
  ): Promise<void> {
    const expiryIso = new Date(
      tokens.expiresAt ?? Date.now() + 3600 * 1000,
    ).toISOString();

    const consumerPayload = JSON.stringify({
      token: {
        access_token: tokens.accessToken,
        token_type: "Bearer",
        refresh_token: tokens.refreshToken ?? "",
        expiry: expiryIso,
      },
      auth_method: "consumer",
      ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
    });

    const oauthPayload = JSON.stringify({
      token: {
        access_token: tokens.accessToken,
        token_type: "Bearer",
        refresh_token: tokens.refreshToken ?? "",
        expiry: expiryIso,
      },
      auth_method: "oauth",
    });

    // 1. Update Windows Credential Manager (`gemini:antigravity` in UTF-8 and `gemini` in UTF-16LE go-keyring-base64)
    await writeWindowsCredentialBytes(
      "gemini:antigravity",
      "antigravity",
      Buffer.from(consumerPayload, "utf8"),
      2,
    );
    const goKeyringString = `go-keyring-base64:${Buffer.from(oauthPayload, "utf8").toString("base64")}`;
    await writeWindowsCredentialBytes(
      "gemini",
      "antigravity",
      Buffer.from(goKeyringString, "utf16le"),
      2,
    );

    // 2. Update ~/.gemini files (`jetski-standalone-oauth-token`, `oauth_creds.json`, `google_accounts.json`)
    const geminiDir = join(homedir(), ".gemini");
    await mkdir(geminiDir, { recursive: true });
    await this.atomicWriteFile(
      join(geminiDir, "jetski-standalone-oauth-token"),
      consumerPayload,
    );
    await this.atomicWriteFile(
      join(geminiDir, "oauth_creds.json"),
      JSON.stringify(
        {
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken ?? "",
          token_type: "Bearer",
          scope: GEMINI_SCOPES,
          expiry_date: tokens.expiresAt ?? Date.now() + 3600 * 1000,
          ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
        },
        null,
        2,
      ),
    );

    if (account.email) {
      const googleAccountsPath = join(geminiDir, "google_accounts.json");
      let oldEmails: string[] = [];
      if (existsSync(googleAccountsPath)) {
        try {
          const prev = JSON.parse(
            await readFile(googleAccountsPath, "utf8"),
          ) as { active?: string; old?: string[] };
          const set = new Set<string>(Array.isArray(prev.old) ? prev.old : []);
          if (prev.active && prev.active !== account.email) {
            set.add(prev.active);
          }
          set.delete(account.email);
          oldEmails = [...set];
        } catch {
          // Ignore invalid file
        }
      }
      await this.atomicWriteFile(
        googleAccountsPath,
        JSON.stringify({ active: account.email, old: oldEmails }, null, 2),
      );
    }
  }

  private async switchClaudeAccount(tokens: StoredAccountTokens): Promise<void> {
    const configDirectory =
      process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    const target = join(configDirectory, ".credentials.json");
    const payload = tokens.raw
      ? tokens.raw
      : JSON.stringify(
          {
            claudeAiOauth: {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken ?? "",
              expiresAt: tokens.expiresAt ?? Date.now() + 3600 * 1000,
            },
          },
          null,
          2,
        );
    await this.atomicWriteFile(target, payload);
  }

  private async atomicWriteFile(target: string, contents: string): Promise<void> {
    const temporaryPath = `${target}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(temporaryPath, contents, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, target);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error(
        `Could not write credential file (${target}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  getActiveProviderTokens(provider: ProviderId): StoredAccountTokens | undefined {
    const activeAcc = this.list().find(
      (a) => a.provider === provider && a.active,
    );
    if (activeAcc) {
      return this.tokensCache.get(activeAcc.id);
    }
    return undefined;
  }
}
