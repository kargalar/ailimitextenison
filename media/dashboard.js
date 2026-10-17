(() => {
  "use strict";
  const vscode = acquireVsCodeApi();
  const names = {
    codex: "Codex",
    gemini: "Gemini",
    gptClaude: "Other",
    argon: "Argon",
    claude: "Claude",
  };
  const icons = window.aiLimitIcons ?? {};
  const providerIcon = (provider) =>
    `<img src="${escape(icons[provider] ?? "")}" alt="" aria-hidden="true">`;
  let state;
  let busy = false;
  let section = vscode.getState()?.section ?? "limits";
  if (!["limits", "accounts", "appearance"].includes(section))
    section = "limits";
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  const percent = (value) =>
    Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const tone = (value) =>
    value < 10 ? "danger" : value < 20 ? "orange" : value < 30 ? "warning" : "";
  const selectStatusWindow = (windows) => {
    const fiveHour = windows.find((w) => /5\s?[- ]?hour|5h/i.test(w.label));
    const weekly = windows.find((w) => /week/i.test(w.label));
    if (weekly && weekly.remainingPercent === 0) return weekly;
    return (
      fiveHour ??
      weekly ??
      windows.reduce(
        (lowest, current) =>
          !lowest || current.remainingPercent < lowest.remainingPercent
            ? current
            : lowest,
        undefined,
      )
    );
  };
  const dateTime = (value) =>
    value
      ? new Date(value).toLocaleString("en-US", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Not updated yet";
  const send = (type, data = {}) => vscode.postMessage({ type, ...data });
  document.getElementById("app").innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><span class="brand-icon">✦</span><span>AI Limit<span class="brand-sub">STATUS</span></span></div>
        <div class="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button class="nav-item" data-section="limits"><span>◫</span> Limits <span class="nav-dot"></span></button>
          <button class="nav-item" data-section="accounts"><span>◎</span> Accounts</button>
          <button class="nav-item" data-section="appearance"><span>◈</span> Appearance</button>
        </nav>
        <div class="sidebar-note"><span class="connection-dot"></span> Connected to local sessions<p>Your limits stay under your control.</p></div>
      </aside>
      <main>
        <header class="topbar"><span>CONTROL CENTER</span><div class="toolbar"><span id="sync-state" role="status"></span><button class="button primary" id="refresh" data-action="refresh">↻ Refresh</button></div></header>
        <div id="notice" class="notice" role="status" hidden></div>
        <section id="limits" class="section">
          <div class="page-heading"><div><p class="eyebrow">LESS TRACKING, MORE CREATING</p><h1>All your limits in one place.</h1><p>See remaining usage and reset times at a glance.</p></div><span class="local-badge">● Live sessions</span></div>
          <div id="summary" class="summary"></div>
          <div class="section-heading"><h2>Your subscriptions</h2><span>Each usage window is shown separately</span></div>
          <div id="providers" class="provider-grid"></div>
          <div id="reset-card"></div>
          <p class="footer-note">Percentages show your remaining quota. Reset details come from each provider's latest response.</p>
        </section>
        <section id="accounts" class="section" hidden>
          <div class="page-heading"><div><p class="eyebrow">YOUR CONNECTIONS</p><h1>Your accounts.</h1><p>View active sessions, switch accounts, or sign in with a new account.</p></div></div>
          <div id="active-accounts" class="provider-grid"></div>
          <div class="section-heading account-section-heading"><div><h2>Saved accounts</h2><span>Switch between sessions or manage an account</span></div><span id="account-count" class="account-count"></span></div>
          <div id="account-history" class="account-grid"></div>
          <div class="info-note"><strong>How account switching works</strong><p>Codex and Claude sign-ins run in isolated profiles, so adding an account does not replace the current session. After sign-in finishes, the new session is saved in VS Code SecretStorage and can be selected from this list. Gemini accounts are managed by Antigravity.</p><p>Removing an account from this extension deletes its saved session and history entry; it does not sign out of the provider.</p></div>
        </section>
        <section id="appearance" class="section" hidden>
          <div class="page-heading"><div><p class="eyebrow">MADE FOR YOU</p><h1>Customize your view.</h1><p>Adjust the status bar and dashboard to fit your workflow. Changes save automatically.</p></div></div>
          <div class="settings-layout"><div class="settings-stack">
            <div class="settings-card"><h2>Visible providers</h2><p>All limits remain available in the dashboard.</p><div id="provider-options"></div><h3>Individual quota indicators</h3><div id="indicator-options"></div></div>
            <div class="settings-card"><h2>Status bar style</h2><div class="style-options"><label><input type="radio" name="statusBarStyle" value="full"><span><strong>Full</strong><small>Codex %72 · 3h</small></span></label><label><input type="radio" name="statusBarStyle" value="compact"><span><strong>Compact</strong><small>⌘ %72 · 3h</small></span></label><label><input type="radio" name="statusBarStyle" value="icon"><span><strong>Icons only</strong><small>OpenAI · Gemini · Claude</small></span></label></div><div id="toggle-options"></div></div>
            <div class="settings-card"><h2>Dashboard and updates</h2><label class="setting-row"><span><strong>Dashboard theme</strong><small>Automatic mode follows your VS Code theme.</small></span><select id="panelTheme" aria-label="Dashboard theme"><option value="auto">Match VS Code</option><option value="dark">Dark</option><option value="light">Light</option></select></label><label class="setting-row"><span><strong>Refresh interval</strong><small>60–3600 seconds for all providers.</small></span><span class="interval-input"><input id="refreshIntervalSeconds" type="number" min="60" max="3600" step="1" aria-label="Refresh interval (seconds)"><span>sec</span></span></label></div>
          </div><aside class="preview-card"><p class="eyebrow">LIVE PREVIEW</p><h2>Your status bar</h2><p>This preview reflects your current settings.</p><div class="editor-preview"><div class="editor-tabs"><i></i><i></i><i></i><span>workspace</span></div><div class="editor-lines"><span></span><span></span><span></span><span></span></div><div id="bar-preview" class="bar-preview"></div></div><p class="preview-caption">Colors reflect the remaining quota:</p><div class="thresholds"><span class="warning">● &lt; 30%</span><span class="orange">● &lt; 20%</span><span class="danger">● &lt; 10%</span></div><p class="preview-caption">If all indicators are hidden, open the dashboard from the Command Palette: “AI Limit Status: Open Dashboard.”</p></aside></div>
        </section>
      </main>
    </div>`;

  function switchSection(next) {
    section = next;
    vscode.setState({ section });
    document.querySelectorAll(".section").forEach((el) => {
      el.hidden = el.id !== section;
    });
    document.querySelectorAll("[data-section]").forEach((el) => {
      el.classList.toggle("active", el.dataset.section === section);
      if (el.dataset.section === section)
        el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    });
    window.scrollTo(0, 0);
  }

  function renderLimits() {
    const connected = state.providers.filter(
      (p) => p.account?.connected,
    ).length;
    const allWindows = state.providers.flatMap((p) => p.windows);
    const lowest = allWindows.length
      ? Math.min(...allWindows.map((w) => w.remainingPercent))
      : undefined;
    document.getElementById("summary").innerHTML =
      `<div class="summary-card"><span>Connected providers</span><strong>${connected}<small> / 3</small></strong><p>Active sessions</p></div><div class="summary-card"><span>Lowest remaining quota</span><strong class="${lowest === undefined ? "" : tone(lowest)}">${lowest === undefined ? "—" : lowest + "%"}</strong><p>Across all usage windows</p></div><div class="summary-card"><span>Automatic refresh</span><strong>${Math.round((state.settings.refreshIntervalSeconds / 60) * 10) / 10}<small> min</small></strong><p>Refresh interval</p></div>`;
    document.getElementById("providers").innerHTML = state.providers
      .map((provider) => {
        const account = provider.account;
        return `<article class="provider-card ${provider.id}"><div class="provider-heading"><span class="provider-symbol">${providerIcon(provider.id)}</span><div><h2>${escape(provider.name)}</h2><span class="source">${escape(provider.source)}</span></div><span class="pill ${provider.error ? "offline" : "online"}">${provider.error ? "Action needed" : provider.windows.length ? "Updated" : "Waiting"}</span></div><div class="provider-account"><span>${escape(account?.email ?? (account?.connected ? "Active session" : "No session information"))}</span>${account?.plan ? `<span class="plan">${escape(account.plan)}</span>` : ""}</div><div class="quotas">${provider.windows.map((window) => `<div class="quota ${tone(window.remainingPercent)}"><div class="quota-title"><span>${escape(window.label)}</span><strong>${percent(window.remainingPercent)}% <small>left</small></strong></div><progress max="100" value="${percent(window.remainingPercent)}" aria-label="${escape(window.label)} remaining percentage"></progress><div class="quota-reset"><span>↻ Resets in ${escape(window.resetLabel)}</span><time>${window.resetsAt ? escape(dateTime(window.resetsAt * 1000)) : "Reset time unavailable"}</time></div></div>`).join("") || `<div class="empty-quota"><span>◌</span><p>No limit data yet.</p></div>`}</div>${provider.error ? `<div class="provider-error">${escape(provider.error)}</div>` : ""}<div class="provider-footer"><span>${escape(dateTime(provider.updatedAt))}</span><button class="text-button" data-login="${provider.id}">Manage account ↗</button></div></article>`;
      })
      .join("");
    document.getElementById("reset-card").innerHTML =
      state.resetCredits > 0
        ? `<div class="reset-card"><div><strong>↻ ${state.resetCredits} Codex reset credits</strong><p>Reset an eligible limit without waiting. Confirmation is required.</p></div><button class="button" data-action="reset">Use a credit</button></div>`
        : "";
  }

  function renderAccounts() {
    document.getElementById("active-accounts").innerHTML = state.providers
      .map((p) => {
        const a = p.account;
        return `<article class="account-card ${p.id}"><div class="provider-heading"><span class="provider-symbol">${providerIcon(p.id)}</span><h2>${escape(p.name)}</h2><span class="pill ${a?.connected ? "online" : "offline"}">${a?.connected ? "Connected" : "Not connected"}</span></div><div class="account-avatar">${escape((a?.email ?? a?.name ?? "?").slice(0, 1).toUpperCase())}</div><h3>${escape(a?.name ?? a?.email ?? "Sign in")}</h3><p class="email">${escape(a?.name ? a.email : (a?.plan ?? "Subscription session"))}</p>${a?.name && a.plan ? `<span class="plan">${escape(a.plan)}</span>` : ""}<p class="account-detail">${escape(a?.detail ?? "Session details are read from the provider's own app.")}</p><button class="button wide" data-login="${p.id}">${a?.connected ? "Add account" : "Sign in"} ↗</button></article>`;
      })
      .join("");
    document.getElementById("account-count").textContent =
      `${state.accounts.length} ${state.accounts.length === 1 ? "account" : "accounts"}`;
    document.getElementById("account-history").innerHTML = state.accounts.length
      ? state.accounts
          .map((account) => {
            const provider = names[account.provider];
            const status = account.active
              ? "Current account"
              : account.sessionSaved
                ? "Session saved securely"
                : account.provider === "gemini"
                  ? "Managed by Antigravity"
                  : "Sign-in required";
            const badge = account.active
              ? "Active"
              : account.sessionSaved
                ? "Saved"
                : "Known";
            const action = account.active
              ? '<button class="button account-switch" disabled aria-current="true">Current account</button>'
              : account.sessionSaved
                ? `<button class="button primary account-switch" data-switch-account="${account.provider}" data-account-id="${account.id}">Switch account <span aria-hidden="true">→</span></button>`
                : account.provider === "gemini"
                  ? `<button class="button primary account-switch" data-switch-account="${account.provider}" data-account-id="${account.id}">Manage in Antigravity <span aria-hidden="true">↗</span></button>`
                  : `<button class="button primary account-switch" data-login="${account.provider}" data-account-id="${account.id}">Sign in to save session <span aria-hidden="true">↗</span></button>`;
            return `<article class="saved-account-card ${account.provider}${account.active ? " is-active" : ""}"><div class="saved-account-top"><span class="provider-symbol">${providerIcon(account.provider)}</span><span class="saved-account-provider">${escape(provider)}</span><span class="pill ${account.active ? "online" : ""}">${badge}</span></div><div class="saved-account-identity"><div class="account-avatar">${escape((account.email ?? account.name ?? "?").slice(0, 1).toUpperCase())}</div><div class="saved-account-copy"><h3 title="${escape(account.email)}">${escape(account.email)}</h3><p>${escape(account.plan ?? "Subscription account")}</p></div></div><div class="saved-account-status"><span class="status-mark ${account.active ? "active" : account.sessionSaved ? "saved" : "managed"}" aria-hidden="true"></span><span>${status}</span><time datetime="${escape(account.lastSeen)}">Last used ${escape(dateTime(account.lastSeen))}</time></div><div class="saved-account-actions">${action}<button class="text-button remove-account" data-forget="${account.id}" title="Remove this account" aria-label="Remove ${escape(account.email)}">Remove</button></div></article>`;
          })
          .join("")
      : '<div class="empty-accounts"><span class="empty-accounts-icon" aria-hidden="true">◎</span><strong>No saved accounts yet</strong><p>Sign in with a provider above. Accounts you add will appear here for quick switching.</p></div>';
  }

  const checkbox = (key, value, label, description) =>
    `<label class="setting-row"><span><strong>${label}</strong>${description ? `<small>${description}</small>` : ""}</span><input type="checkbox" role="switch" data-setting="${key}" ${value ? `data-value="${value}"` : ""} aria-label="${label}"></label>`;
  document.getElementById("provider-options").innerHTML = [
    "codex",
    "gemini",
    "claude",
  ]
    .map((id) =>
      checkbox(
        "visibleProviders",
        id,
        id === "gemini" ? "Gemini / Antigravity" : names[id],
        "",
      ),
    )
    .join("");
  document.getElementById("indicator-options").innerHTML = Object.keys(names)
    .map((id) => checkbox("visibleIndicators", id, names[id], ""))
    .join("");
  document.getElementById("toggle-options").innerHTML = [
    [
      "showIcons",
      "Provider icons",
      "Icons are always shown in icon-only style.",
    ],
    [
      "showResetTime",
      "Time until reset",
      "Show days above 1 day; hide minutes above 10 hours.",
    ],
    [
      "showResetCredits",
      "Codex reset credits",
      "Show only when credits are available.",
    ],
    [
      "colorize",
      "Quota warning colors",
      "Use muted yellow, orange, and red for low quotas.",
    ],
  ]
    .map(([key, label, desc]) => checkbox(key, "", label, desc))
    .join("");

  function syncSettings() {
    const settings = state.settings;
    document.body.dataset.theme = settings.panelTheme;
    document.querySelectorAll("[data-setting]").forEach((input) => {
      input.checked = input.dataset.value
        ? settings[input.dataset.setting].includes(input.dataset.value)
        : settings[input.dataset.setting];
    });
    document.querySelectorAll('[name="statusBarStyle"]').forEach((input) => {
      input.checked = input.value === settings.statusBarStyle;
    });
    document.getElementById("panelTheme").value = settings.panelTheme;
    const interval = document.getElementById("refreshIntervalSeconds");
    if (document.activeElement !== interval)
      interval.value = settings.refreshIntervalSeconds;
    renderPreview();
  }

  function renderPreview() {
    const s = state.settings;
    const indicators = [];
    for (const key of ["codex", "claude", "gemini", "gptClaude", "argon"]) {
      const providerId =
        key === "gptClaude" || key === "argon" ? "gemini" : key;
      const p = state.providers.find((provider) => provider.id === providerId);
      if (!p || !s.visibleProviders.includes(p.id)) continue;
      if (!s.visibleIndicators.includes(key)) continue;
      const windows = p.windows.filter(
        (w) => p.id !== "gemini" || w.label.startsWith(names[key] + " ·"),
      );
      const window = selectStatusWindow(windows);
      const iconOnly = s.statusBarStyle === "icon";
      const icon = s.showIcons || iconOnly ? providerIcon(p.id) + " " : "";
      const windowText = window
        ? "%" +
          window.remainingPercent +
          (s.showResetTime ? " · " + escape(window.resetLabel) : "")
        : "—";
      const text = iconOnly
        ? icon
        : icon +
          (s.statusBarStyle === "full" ? names[key] + " " : "") +
          windowText;
      indicators.push(
        `<span class="${s.colorize && window ? tone(window.remainingPercent) : ""}">${text}</span>`,
      );
    }
    if (
      s.showResetCredits &&
      state.resetCredits > 0 &&
      s.visibleProviders.includes("codex") &&
      s.visibleIndicators.includes("codex")
    )
      indicators.unshift(
        `<span class="warning">Reset ${state.resetCredits}</span>`,
      );
    document.getElementById("bar-preview").innerHTML =
      indicators.join("") || "<span>No indicators enabled</span>";
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.section) {
      switchSection(button.dataset.section);
      return;
    }
    if (busy) return;
    if (button.dataset.switchAccount)
      send("switchAccount", {
        provider: button.dataset.switchAccount,
        accountId: button.dataset.accountId,
      });
    else if (button.dataset.login)
      send("login", {
        provider: button.dataset.login,
        accountId: button.dataset.accountId,
      });
    else if (button.dataset.forget)
      send("forget", { id: button.dataset.forget });
    else if (button.dataset.action) send(button.dataset.action);
  });
  document.addEventListener("change", (event) => {
    if (!state) return;
    const input = event.target;
    let patch;
    if (input.dataset.setting) {
      const key = input.dataset.setting;
      patch = {
        [key]: input.dataset.value
          ? [
              ...document.querySelectorAll(`[data-setting="${key}"]:checked`),
            ].map((el) => el.dataset.value)
          : input.checked,
      };
    } else if (input.name === "statusBarStyle")
      patch = { statusBarStyle: input.value };
    else if (input.id === "panelTheme") patch = { panelTheme: input.value };
    else if (input.id === "refreshIntervalSeconds") {
      if (!input.checkValidity()) {
        input.reportValidity();
        return;
      }
      patch = { refreshIntervalSeconds: Number(input.value) };
    }
    if (patch) {
      Object.assign(state.settings, patch);
      syncSettings();
      send("save", { settings: patch });
    }
  });
  window.addEventListener("message", ({ data }) => {
    if (data.type === "notice") {
      const notice = document.getElementById("notice");
      notice.textContent = data.message;
      notice.classList.toggle("error", data.error === true);
      notice.hidden = false;
      return;
    }
    if (data.type !== "state") return;
    state = data.state;
    busy = data.busy;
    renderLimits();
    renderAccounts();
    syncSettings();
    document.getElementById("sync-state").textContent = state.refreshing
      ? "Refreshing…"
      : "Automatic refresh is on";
    document.getElementById("refresh").disabled = busy || state.refreshing;
    document
      .querySelectorAll("[data-login], [data-switch-account], [data-forget], [data-action=reset]")
      .forEach((button) => {
        button.disabled = busy || state.refreshing;
      });
  });
  switchSection(section);
  send("ready");
})();
