# AI Limit Status

Track Codex, Gemini, Antigravity, and Claude subscription usage in a single VS Code status bar.

The extension shows the available limit percentage, time until renewal, and the number of reset credits for supported accounts. Colors change as the limit decreases: **yellow below 30%**, **orange below 20%**, and **red below 10%**.

## Displayed limits

| Status bar group | Displayed information                                                                           | Data source                                                |
| ---------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Codex**        | Remaining percentage and renewal time in usage windows, plus reset credits when available       | Local Codex CLI `app-server`                               |
| **Gemini**       | Separate limits and weekly renewal times for the Gemini, Other, and Argon model groups         | Local quota service of the running Antigravity application |
| **Claude**       | Five-hour and weekly usage; Sonnet and Opus weekly limits when included in the account response | Claude Code Pro/Max OAuth subscription session             |

Click any limit item in the status bar to open the dashboard as a tab in the VS Code editor area. The **AI Limit Status: Open Dashboard** command also opens it when all status indicators are hidden.

## Dashboard

- **Limits:** Separate usage windows for Codex, Gemini, Other, Argon, and Claude, with remaining percentages, progress bars, renewal times, and the last successful update.
- **Accounts:** Active account identities and subscription information returned by the providers, plus a local history of accounts seen by the extension.
- **Appearance:** Provider and indicator visibility, full/compact/icon-only status bar styles, provider marks, reset countdowns, warning colors, and Codex reset credits. The live preview reflects these choices.
- **Theme and refresh:** Follow the VS Code theme or choose a light or dark panel. Adjust the shared refresh interval from 60 to 3600 seconds.

When you click a Codex reset credit, the extension checks eligibility and asks for confirmation before using it. Hiding a provider in the status bar does not hide its data in the dashboard.

## Account switching

Select **Accounts** and choose **Add account** under a provider. Codex and Claude sign-ins run in an isolated profile, so adding a new account does not replace the currently active session. When sign-in finishes, the extension saves the new session automatically. Use **Switch account** to activate a saved Codex or Claude session. Gemini accounts are managed by Antigravity; use **Manage in Antigravity**, select the account there, and refresh the dashboard.

Codex and Claude session snapshots are stored in VS Code SecretStorage and restored to the provider's local credential file when you switch accounts. Temporary isolated sign-in profiles are removed after the session is saved. Gemini authentication is managed by Antigravity, so account selection happens in that app. Existing provider processes or conversations may retain their previous session until reloaded. The account history lists only accounts observed by this extension, rather than every account stored elsewhere on the machine.

## Requirements

- VS Code 1.90 or later
- **Codex limits:** The Codex CLI must be installed and signed in to a Codex account.
- **Gemini, Other, and Argon limits:** Antigravity must be running and signed in. This integration uses Windows PowerShell.
- **Claude subscription limits:** You must be signed in to Claude Code with a Claude Pro or Max OAuth account. Authentication with an API key alone does not show subscription usage.

## Installation

Download the `.vsix` file from the GitHub Releases section. In the VS Code terminal, navigate to the folder containing the file and run:

```powershell
code --install-extension .\ai-limit-status-1.3.3.vsix
```

Alternatively, open the **Extensions** view in VS Code, select **Install from VSIX...** from the `...` menu, and choose the downloaded file.

## Settings

| Setting                             | Default                     | Description                                                                                                                             |
| ----------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `codexUsage.refreshIntervalSeconds` | `300`                       | Refresh interval for all providers. It can be set between 60 and 3600 seconds and changed from the dashboard.                           |
| `codexUsage.codexExecutable`        | `codex`                     | Codex CLI command or full path to the executable. On Windows, enter the path to `codex.exe` if needed.                                  |
| `aiQuotaStatus.visibleProviders`    | `codex`, `gemini`, `claude` | Limit groups shown in the status bar. The Gemini group includes Gemini, Other, and Argon limits. Select groups from the dashboard.       |
| `aiQuotaStatus.visibleIndicators`   | All five indicators         | Show or hide Codex, Gemini, Other, Argon, and Claude individually.                                                                      |
| `aiQuotaStatus.statusBarStyle`      | `full`                      | `full`, `compact`, or `icon`.                                                                                                           |
| `aiQuotaStatus.showIcons`           | `true`                      | Include provider icons; icon-only mode always shows them.                                                                               |
| `aiQuotaStatus.showResetTime`       | `true`                      | Include renewal countdowns in the status bar.                                                                                           |
| `aiQuotaStatus.showResetCredits`    | `true`                      | Show the reset-credit item when credits are available.                                                                                  |
| `aiQuotaStatus.colorize`            | `true`                      | Use muted low-quota warning colors.                                                                                                     |
| `aiQuotaStatus.panelTheme`          | `auto`                      | `auto`, `dark`, or `light`.                                                                                                             |

The dashboard and status bar use the OpenAI knot mark for Codex and the Google Gemini and Claude marks. The status bar uses monochrome glyphs of these logos so they follow VS Code's status bar colors.

## Brand assets

- Codex mark: OpenAI's official [OpenAI Logos](https://cdn.openai.com/brand/OpenAI-Logos-2025.zip) package, adapted from `OpenAI-black-monoblossom.svg` and recolored for the dashboard.
- Gemini and Claude marks: [Simple Icons](https://github.com/simple-icons/simple-icons), distributed under [CC0 1.0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md). The Google Gemini and Claude names and marks belong to their respective owners.

## Building from source

```powershell
npm ci
npm run check-types
npm run compile
npm run package
```

When packaging completes, a `.vsix` file is created in the project folder. To install the extension in your local VS Code installation:

```powershell
code --install-extension .\ai-limit-status-1.3.3.vsix
```

## Privacy and security

- The extension uses providers' local application or CLI sessions to retrieve limit information. This project does not send data to its own server and contains no telemetry.
- The dashboard receives account display information and quota values, never access tokens. Account history stores email addresses, names, plan information, and timestamps in VS Code's local extension storage. Codex and Claude sign-in session snapshots are stored separately in VS Code SecretStorage for account switching. Removing an account from the extension deletes its saved session but does not sign out of the provider.
- To retrieve Claude subscription usage, the OAuth access token is read from the local Claude Code credential file into memory and sent directly to `api.anthropic.com` over HTTPS. The token is not stored or logged by the extension.
- The Claude Code usage service does not expose the consumer subscription endpoint used here as a public, documented API. Anthropic may change the behavior of this endpoint, which could affect the display of Claude limits. See the [Anthropic help page](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan) for information about using Claude Code with a subscription.

## License

MIT
