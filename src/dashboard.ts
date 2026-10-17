import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import {
  DashboardState,
  DisplaySettings,
  isProviderId,
  ProviderId,
  validateSettings,
} from "./dashboard-model";

interface DashboardActions {
  refresh(): Promise<void>;
  save(settings: Partial<DisplaySettings>): Promise<void>;
  login(provider: ProviderId, email?: string): Promise<"isolated" | "managed">;
  switchAccount(
    provider: ProviderId,
    id: string,
  ): Promise<"switched" | "manage">;
  forget(id: string): Promise<void>;
  reset(): Promise<void>;
}

export class Dashboard implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private busy = false;
  private messages: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: () => DashboardState,
    private readonly actions: DashboardActions,
  ) {}

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      this.publish();
      return;
    }
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const panel = vscode.window.createWebviewPanel(
      "aiLimitStatus.dashboard",
      "AI Limit Status",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [media],
      },
    );
    this.panel = panel;
    const nonce = randomBytes(24).toString("base64");
    const style = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(media, "dashboard.css"),
    );
    const script = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(media, "dashboard.js"),
    );
    const icons = Object.fromEntries(
      ["codex", "gemini", "claude"].map((provider) => [
        provider,
        panel.webview.asWebviewUri(
          vscode.Uri.joinPath(
            media,
            "icons",
            provider === "gemini" ? "googlegemini.svg" : `${provider}.svg`,
          ),
        ).toString(),
      ]),
    );
    panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; img-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"><title>AI Limit Status</title><link rel="stylesheet" href="${style}"></head><body><div id="app"><p class="boot">Loading your limits…</p></div><script nonce="${nonce}">window.aiLimitIcons = ${JSON.stringify(icons).replace(/</g, "\\u003c")};</script><script nonce="${nonce}" src="${script}"></script></body></html>`;
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    const listener = panel.webview.onDidReceiveMessage((message: unknown) => {
      this.messages = this.messages.then(() => this.receive(message));
    });
    panel.onDidDispose(() => listener.dispose());
    await this.actions.refresh();
  }

  publish(): void {
    if (this.panel)
      void this.panel.webview.postMessage({
        type: "state",
        state: this.state(),
        busy: this.busy,
      });
  }

  private async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") return;
    const data = message as Record<string, unknown>;
    if (data.type === "ready") {
      this.publish();
      return;
    }
    this.busy = true;
    this.publish();
    try {
      switch (data.type) {
        case "refresh":
          await this.actions.refresh();
          break;
        case "save":
          await this.actions.save(validateSettings(data.settings));
          break;
        case "login": {
          if (!isProviderId(data.provider))
            throw new Error("Invalid provider.");
          let email: string | undefined;
          if (typeof data.accountId === "string") {
            const account = this.state().accounts.find(
              (entry) =>
                entry.id === data.accountId && entry.provider === data.provider,
            );
            if (!account) throw new Error("Account record not found.");
            email = account.email;
          }
          const mode = await this.actions.login(data.provider, email);
          void this.panel?.webview.postMessage({
            type: "notice",
            message:
              mode === "isolated"
                ? `Sign in${email ? ` as ${email}` : ""} in the new terminal. Your current account stays active; the new session is saved when sign-in finishes.`
                : "Antigravity account management is open. Add a Google account there; Antigravity controls which Gemini account is active.",
          });
          break;
        }
        case "switchAccount": {
          if (!isProviderId(data.provider) || typeof data.accountId !== "string")
            throw new Error("Invalid account selection.");
          const result = await this.actions.switchAccount(
            data.provider,
            data.accountId,
          );
          void this.panel?.webview.postMessage({
            type: "notice",
            message:
              result === "switched"
                ? "Switched accounts and refreshed your limits."
                : "Antigravity account management is open. Select an account, then refresh your limits.",
          });
          break;
        }
        case "forget":
          if (typeof data.id === "string") await this.actions.forget(data.id);
          break;
        case "reset":
          await this.actions.reset();
          break;
      }
    } catch (error) {
      void this.panel?.webview.postMessage({
        type: "notice",
        error: true,
        message:
          error instanceof Error ? error.message : "The operation could not be completed.",
      });
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
