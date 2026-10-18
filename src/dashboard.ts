import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import {
  DashboardState,
  DisplaySettings,
  isProviderId,
  ProviderId,
  validateSettings,
} from "./dashboard-model";

export interface DashboardActions {
  refresh(): Promise<void>;
  save(settings: Partial<DisplaySettings>): Promise<void>;
  prepareOAuth(provider: ProviderId): Promise<void>;
  openExternalUrl(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  completeOAuth(sessionId: string, callbackInput: string): Promise<string>;
  cancelOAuth(): Promise<void>;
  importAccountJson(provider: ProviderId, rawJson: string): Promise<string>;
  switchAccount(provider: ProviderId, id: string): Promise<string>;
  refreshAccount(id: string): Promise<void>;
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
    const pkg = this.context.extension.packageJSON as { version?: string };
    const version = typeof pkg?.version === "string" ? pkg.version : "1.4.2";
    panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; img-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"><title>AI Limit Status v${version}</title><link rel="stylesheet" href="${style}"></head><body><div id="app"><p class="boot">Loading your limits…</p></div><script nonce="${nonce}">window.aiLimitIcons = ${JSON.stringify(icons).replace(/</g, "\\u003c")}; window.aiLimitVersion = ${JSON.stringify(version)};</script><script nonce="${nonce}" src="${script}"></script></body></html>`;
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

    if (data.type === "copyText") {
      if (typeof data.text === "string") {
        await this.actions.copyText(data.text);
        void this.panel?.webview.postMessage({
          type: "notice",
          message: "Authorization link copied to clipboard.",
        });
      }
      return;
    }

    if (data.type === "openExternalUrl") {
      if (typeof data.url === "string") {
        await this.actions.openExternalUrl(data.url);
      }
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
        case "prepareOAuth":
        case "login": {
          const provider = isProviderId(data.provider)
            ? data.provider
            : "gemini";
          await this.actions.prepareOAuth(provider);
          break;
        }
        case "completeOAuth": {
          const sessionId =
            typeof data.sessionId === "string" ? data.sessionId : "";
          const callbackUrl =
            typeof data.callbackUrl === "string" ? data.callbackUrl : "";
          const email = await this.actions.completeOAuth(
            sessionId,
            callbackUrl,
          );
          void this.panel?.webview.postMessage({
            type: "notice",
            message: `Account ${email} added and quota loaded!`,
          });
          break;
        }
        case "cancelOAuth":
          await this.actions.cancelOAuth();
          break;
        case "importAccountJson": {
          if (!isProviderId(data.provider) || typeof data.rawJson !== "string")
            throw new Error("Invalid import payload.");
          const email = await this.actions.importAccountJson(
            data.provider,
            data.rawJson,
          );
          void this.panel?.webview.postMessage({
            type: "notice",
            message: `Account ${email} imported and quota loaded!`,
          });
          break;
        }
        case "switchAccount": {
          if (
            !isProviderId(data.provider) ||
            typeof data.accountId !== "string"
          )
            throw new Error("Invalid account selection.");
          const switchedEmail = await this.actions.switchAccount(
            data.provider,
            data.accountId,
          );
          void this.panel?.webview.postMessage({
            type: "notice",
            message: `Switched active ${data.provider.toUpperCase()} account to ${switchedEmail}.`,
          });
          break;
        }
        case "refreshAccount": {
          if (typeof data.accountId === "string") {
            await this.actions.refreshAccount(data.accountId);
            void this.panel?.webview.postMessage({
              type: "notice",
              message: "Account quota refreshed.",
            });
          }
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
          error instanceof Error
            ? error.message
            : "The operation could not be completed.",
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
