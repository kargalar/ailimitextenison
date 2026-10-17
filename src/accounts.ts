import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { AccountIdentity, KnownAccount, ProviderId } from "./dashboard-model";

const run = promisify(execFile);
const HISTORY_KEY = "aiLimitStatus.accountHistory.v1";
const MAX_HISTORY = 30;
const AUTH_TIMEOUT_MS = 10_000;
const SESSION_SECRET_PREFIX = "aiLimitStatus.accountSession.v1.";

interface SavedSession {
  path: string;
  contents: string;
}

export interface AccountLoginFlow {
  provider: "codex" | "claude";
  profileDirectory: string;
  terminal: vscode.Terminal;
}

function accountId(provider: ProviderId, email: string): string {
  return createHash("sha256")
    .update(`${provider}:${email.toLowerCase()}`)
    .digest("hex")
    .slice(0, 24);
}

function sessionPath(provider: ProviderId): string | undefined {
  if (provider === "codex") {
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    return join(codexHome, "auth.json");
  }
  if (provider === "claude") {
    const configDirectory =
      process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    return join(configDirectory, ".credentials.json");
  }
  return undefined;
}

function secretKey(provider: ProviderId, id: string): string {
  return `${SESSION_SECRET_PREFIX}${provider}.${id}`;
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

export class AccountDirectory {
  private current = new Map<ProviderId, AccountIdentity>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  get(provider: ProviderId): AccountIdentity | undefined {
    return this.current.get(provider);
  }

  async record(identities: AccountIdentity[]): Promise<void> {
    const history = this.context.globalState.get<KnownAccount[]>(
      HISTORY_KEY,
      [],
    );
    for (const identity of identities) {
      this.current.set(identity.provider, identity);
      if (!identity.connected || !identity.email) continue;
      const id = accountId(identity.provider, identity.email);
      const sessionSaved = await this.captureSession(identity.provider, id);
      const entry: KnownAccount = {
        ...identity,
        id,
        lastSeen: new Date().toISOString(),
        active: true,
        sessionSaved,
      };
      const existing = history.findIndex((account) => account.id === id);
      if (existing >= 0) history[existing] = entry;
      else history.push(entry);
    }
    await this.context.globalState.update(
      HISTORY_KEY,
      history
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
        .slice(0, MAX_HISTORY),
    );
  }

  list(): KnownAccount[] {
    return this.context.globalState
      .get<KnownAccount[]>(HISTORY_KEY, [])
      .map((account) => ({
        ...account,
        active:
          this.current.get(account.provider)?.connected === true &&
          this.current.get(account.provider)?.email?.toLowerCase() ===
            account.email?.toLowerCase(),
      }));
  }

  async forget(id: string): Promise<void> {
    const history = this.context.globalState.get<KnownAccount[]>(HISTORY_KEY, []);
    const removed = history.find((account) => account.id === id);
    const remaining = history.filter((account) => account.id !== id);
    await this.context.globalState.update(HISTORY_KEY, remaining);
    if (removed) {
      await this.context.secrets.delete(
        secretKey(removed.provider, removed.id),
      );
    }
  }

  async saveLoginSession(
    identity: AccountIdentity,
    sourcePath: string,
  ): Promise<void> {
    if (!identity.connected || !identity.email) {
      throw new Error("The new sign-in did not return an account identity.");
    }
    const targetPath = sessionPath(identity.provider);
    if (!targetPath) {
      throw new Error("This provider does not support saved sessions here.");
    }
    const contents = await readFile(sourcePath, "utf8");
    const id = accountId(identity.provider, identity.email);
    await this.context.secrets.store(
      secretKey(identity.provider, id),
      JSON.stringify({ path: targetPath, contents } satisfies SavedSession),
    );

    const history = this.context.globalState.get<KnownAccount[]>(
      HISTORY_KEY,
      [],
    );
    const entry: KnownAccount = {
      ...identity,
      id,
      lastSeen: new Date().toISOString(),
      active: false,
      sessionSaved: true,
    };
    const existing = history.findIndex((account) => account.id === id);
    if (existing >= 0) history[existing] = entry;
    else history.push(entry);
    await this.context.globalState.update(
      HISTORY_KEY,
      history
        .sort((left, right) => right.lastSeen.localeCompare(left.lastSeen))
        .slice(0, MAX_HISTORY),
    );
  }

  async switchTo(id: string, provider: ProviderId): Promise<void> {
    const account = this.context.globalState
      .get<KnownAccount[]>(HISTORY_KEY, [])
      .find((entry) => entry.id === id && entry.provider === provider);
    if (!account) throw new Error("The selected account was not found.");
    const key = secretKey(provider, id);
    const saved = await this.context.secrets.get(key);
    if (!saved) {
      throw new Error(
        "No saved sign-in session is available for this account. Add the account again to save its session.",
      );
    }

    const target = sessionPath(provider);
    let snapshot: SavedSession;
    try {
      snapshot = JSON.parse(saved) as SavedSession;
    } catch {
      throw new Error("The saved sign-in session could not be read.");
    }
    if (!target || snapshot.path !== target) {
      throw new Error(
        "This account was saved to a different credential location. Sign in again to save it here.",
      );
    }

    const current = this.current.get(provider);
    if (current?.connected && current.email) {
      await this.captureSession(provider, accountId(provider, current.email));
    }

    const temporaryPath = `${target}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(temporaryPath, snapshot.contents, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, target);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error(
        `Could not restore the saved sign-in session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async captureSession(
    provider: ProviderId,
    id: string,
  ): Promise<boolean> {
    const path = sessionPath(provider);
    if (!path) return false;
    try {
      const contents = await readFile(path, "utf8");
      const session: SavedSession = { path, contents };
      await this.context.secrets.store(
        secretKey(provider, id),
        JSON.stringify(session),
      );
      return true;
    } catch {
      return false;
    }
  }
}

export async function startAccountLogin(
  provider: ProviderId,
  codexExecutable: () => string,
  profileRoot: string,
  email?: string,
): Promise<AccountLoginFlow | undefined> {
  if (provider === "gemini") {
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes("antigravity.openSettings")) {
      await vscode.commands.executeCommand("antigravity.openSettings");
      return;
    }
    const executable = join(
      homedir(),
      ".gemini",
      "bin",
      process.platform === "win32" ? "agy.exe" : "agy",
    );
    if (!existsSync(executable))
      throw new Error(
        "Antigravity was not found. Open Antigravity and sign in from the account menu.",
      );
    vscode.window
      .createTerminal({
        name: "Antigravity • Account management",
        shellPath: executable,
      })
      .show();
    return undefined;
  }
  const label = provider === "codex" ? "Codex" : "Claude";
  const profileDirectory = join(profileRoot, `account-login-${randomUUID()}`);
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  const env =
    provider === "codex"
      ? { CODEX_HOME: profileDirectory }
      : { CLAUDE_CONFIG_DIR: profileDirectory };
  const terminal = vscode.window.createTerminal({
    name: `${label} • Add account${email ? ` · ${email}` : ""}`,
    shellPath: provider === "codex" ? codexExecutable() : claudeExecutable(),
    shellArgs:
      provider === "codex"
        ? ["login"]
        : ["auth", "login", "--claudeai", ...(email ? ["--email", email] : [])],
    env,
  });
  terminal.show();
  return { provider, profileDirectory, terminal };
}
