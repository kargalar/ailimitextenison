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
  const providerFullNames = {
    gemini: "Gemini / Antigravity",
    codex: "OpenAI Codex",
    claude: "Anthropic Claude",
  };
  const icons = window.aiLimitIcons ?? {};
  const providerIcon = (provider) =>
    `<img src="${escape(icons[provider] ?? "")}" alt="" aria-hidden="true">`;
  let state;
  let busy = false;
  let section = vscode.getState()?.section ?? "accounts";
  if (!["accounts", "appearance"].includes(section))
    section = "accounts";

  let accountFilter = "all";
  let modalOpen = false;
  let modalProvider = "gemini";
  let modalTab = "oauth";
  let callbackDraft = "";
  let jsonDraft = "";

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
  const renderProgressRing = (value, toneClass = "", size = 16) => {
    const val = percent(value);
    const r = (size - 3) / 2;
    const cx = size / 2;
    const cy = size / 2;
    const circumference = 2 * Math.PI * r;
    const offset = circumference * (1 - val / 100);
    return `<svg class="progress-ring ${toneClass}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle class="ring-track" cx="${cx}" cy="${cy}" r="${r}" stroke-width="2.2" fill="none" /><circle class="ring-fill" cx="${cx}" cy="${cy}" r="${r}" stroke-width="2.2" fill="none" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})" /></svg>`;
  };
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

  const appVersion = window.aiLimitVersion || "1.4.2";

  document.getElementById("app").innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><span class="brand-icon">✦</span><div><span>AI Limit</span><span class="brand-sub">STATUS</span><span class="brand-version">v${escape(appVersion)}</span></div></div>
        <div class="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button class="nav-item" data-section="accounts"><span>◎</span> Hesaplar &amp; Limitler <span class="nav-dot"></span></button>
          <button class="nav-item" data-section="appearance"><span>◈</span> Görünüm <span class="nav-dot"></span></button>
        </nav>
        <div class="sidebar-note"><span class="connection-dot"></span> Multi-account OAuth ready<p>Tüm hesaplarınızı ve limitlerinizi tek ekrandan yönetin.</p></div>
      </aside>
      <main>
        <header class="topbar"><span>CONTROL CENTER</span><div class="toolbar"><span id="sync-state" role="status"></span><button class="button" data-open-add="gemini">+ Yeni Hesap Ekle</button><button class="button primary" id="refresh" data-action="refresh">↻ Tümünü Yenile</button></div></header>
        <div id="notice" class="notice" role="status" hidden></div>
        <section id="accounts" class="section">
          <div class="page-heading">
            <div>
              <p class="eyebrow">HESAP VE LİMİT MERKEZİ</p>
              <h1>Hesaplarınız ve Limitleriniz</h1>
              <p>Tüm ekli hesaplarınızın anlık kotaları, sıfırlanma süreleri ve tek tıkla hesap değiştirme.</p>
            </div>
            <button class="button primary" data-open-add="gemini">+ Yeni Hesap Ekle</button>
          </div>
          <div id="reset-card"></div>
          <div class="section-heading account-section-heading">
            <div class="account-filter-bar">
              <div class="filter-pills" role="tablist" aria-label="Sağlayıcıya göre filtrele">
                <button class="filter-pill active" data-filter="all">Tümü</button>
                <button class="filter-pill" data-filter="gemini">Gemini / Antigravity</button>
                <button class="filter-pill" data-filter="codex">Codex</button>
                <button class="filter-pill" data-filter="claude">Claude</button>
              </div>
              <span id="account-count" class="account-count"></span>
            </div>
          </div>
          <div id="account-history" class="account-grid"></div>
          <div class="info-note">
            <strong>OAuth Giriş Linki &amp; Geri Dönüş Linki (Callback) ile Hesap Ekleme</strong>
            <p><b>+ Yeni Hesap Ekle</b> butonuna tıklayarak Google, OpenAI veya Anthropic giriş bağlantısını alın. Tarayıcınızda açıp giriş yaptıktan sonra açılan sayfanın linkini (<code>http://localhost:.../?code=...</code>) yapıştırıp onaylayın.</p>
            <p>Eklenen tüm hesaplar aynı anda kayıtlı tutulur, her birinin kalan token yüzdeleri ve sayaçları anlık güncellenir. İstediğiniz hesaba tek tıkla geçiş yapabilirsiniz.</p>
          </div>
        </section>
        <section id="appearance" class="section" hidden>
          <div class="page-heading"><div><p class="eyebrow">ÖZELLEŞTİRME</p><h1>Görünümü Ayarlayın</h1><p>Durum çubuğunu ve panel seçeneklerini iş akışınıza göre düzenleyin. Değişiklikler otomatik kaydedilir.</p></div></div>
          <div class="settings-layout"><div class="settings-stack">
            <div class="settings-card"><h2>Görünen Sağlayıcılar</h2><p>Tüm limitler panelde görüntülenmeye devam eder.</p><div id="provider-options"></div><h3>Bireysel Kota Göstergeleri</h3><div id="indicator-options"></div></div>
            <div class="settings-card"><h2>Durum Çubuğu Stili</h2><div class="style-options"><label><input type="radio" name="statusBarStyle" value="full"><span><strong>Tam</strong><small>Codex 72% ◯ · 3h</small></span></label><label><input type="radio" name="statusBarStyle" value="compact"><span><strong>Kompakt</strong><small>⌘ 72% ◯ · 3h</small></span></label><label><input type="radio" name="statusBarStyle" value="icon"><span><strong>Yalnızca İkon</strong><small>OpenAI · Gemini · Claude</small></span></label></div><div id="toggle-options"></div></div>
            <div class="settings-card"><h2>Panel ve Güncellemeler</h2><label class="setting-row"><span><strong>Tema</strong><small>Otomatik mod VS Code temanızı takip eder.</small></span><select id="panelTheme" aria-label="Dashboard theme"><option value="auto">VS Code ile Uyumlu</option><option value="dark">Koyu</option><option value="light">Açık</option></select></label><label class="setting-row"><span><strong>Yenileme Aralığı</strong><small>Tüm sağlayıcılar için 60–3600 saniye.</small></span><span class="interval-input"><input id="refreshIntervalSeconds" type="number" min="60" max="3600" step="1" aria-label="Refresh interval (seconds)"><span>sn</span></span></label></div>
          </div><aside class="preview-card"><p class="eyebrow">CANLI ÖNİZLEME</p><h2>Durum Çubuğunuz</h2><p>Bu önizleme geçerli ayarlarınızı yansıtır.</p><div class="editor-preview"><div class="editor-tabs"><i></i><i></i><i></i><span>workspace</span></div><div class="editor-lines"><span></span><span></span><span></span><span></span></div><div id="bar-preview" class="bar-preview"></div></div><p class="preview-caption">Kalan kotaya göre renkler:</p><div class="thresholds"><span class="warning">● &lt; 30%</span><span class="orange">● &lt; 20%</span><span class="danger">● &lt; 10%</span></div><p class="preview-caption">Tüm göstergeler gizliyse Komut Paletinden açabilirsiniz: “AI Limit Status: Open Dashboard.”</p></aside></div>
        </section>
      </main>
    </div>
    <div id="oauth-modal" class="modal-backdrop" hidden></div>`;

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

  function openAddAccountModal(provider) {
    modalProvider = provider || "gemini";
    modalOpen = true;
    modalTab = "oauth";
    callbackDraft = "";
    renderOAuthModal();
    send("prepareOAuth", { provider: modalProvider });
  }

  function closeAddAccountModal() {
    modalOpen = false;
    callbackDraft = "";
    jsonDraft = "";
    document.getElementById("oauth-modal").hidden = true;
    send("cancelOAuth");
  }

  function renderOAuthModal() {
    const modalEl = document.getElementById("oauth-modal");
    if (!modalOpen) {
      modalEl.hidden = true;
      return;
    }
    modalEl.hidden = false;

    const session =
      state?.oauthSession && state.oauthSession.provider === modalProvider
        ? state.oauthSession
        : undefined;
    const authUrl = session?.authUrl ?? "Generating authorization link…";
    const statusMsg =
      session?.message ??
      "Preparing OAuth PKCE session and local callback listener…";
    const isError = session?.status === "error";

    modalEl.innerHTML = `
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-header">
          <div>
            <p class="eyebrow">ADD ACCOUNT</p>
            <h2 id="modal-title">Connect ${escape(providerFullNames[modalProvider] ?? modalProvider)}</h2>
          </div>
          <button class="modal-close" data-close-modal="true" aria-label="Close modal">✕</button>
        </div>

        <div class="modal-provider-tabs">
          ${["gemini", "codex", "claude"]
            .map(
              (p) => `
            <button class="provider-tab ${modalProvider === p ? "active" : ""}" data-modal-provider="${p}">
              <span class="provider-symbol">${providerIcon(p)}</span>
              <span>${escape(providerFullNames[p])}</span>
            </button>`,
            )
            .join("")}
        </div>

        <div class="modal-mode-tabs">
          <button class="mode-tab ${modalTab === "oauth" ? "active" : ""}" data-modal-tab="oauth">🔗 OAuth Link &amp; Callback URL</button>
          <button class="mode-tab ${modalTab === "json" ? "active" : ""}" data-modal-tab="json">{ } Import Token / JSON</button>
        </div>

        ${
          modalTab === "oauth"
            ? `
          <div class="modal-body">
            <div class="oauth-step">
              <div class="oauth-step-header">
                <span class="step-badge">1</span>
                <div>
                  <strong>Open or copy the OAuth authorization link</strong>
                  <small>Sign in with your ${escape(names[modalProvider])} account in the browser.</small>
                </div>
              </div>
              <div class="oauth-url-row">
                <input type="text" class="oauth-input" id="oauth-auth-url" readonly value="${escape(authUrl)}" aria-label="Authorization link">
                <button class="button" data-copy-oauth="true" ${!session?.authUrl ? "disabled" : ""}>Copy Link</button>
                <button class="button primary" data-open-oauth="true" ${!session?.authUrl ? "disabled" : ""}>Open in Browser ↗</button>
              </div>
            </div>

            <div class="oauth-step">
              <div class="oauth-step-header">
                <span class="step-badge">2</span>
                <div>
                  <strong>Paste the Callback / Redirect URL (Geri Dönüş Linki)</strong>
                  <small>After signing in, if the browser redirects to <code>${escape(session?.redirectUri ?? "http://localhost:...")}</code>, copy that full URL from the address bar and paste it here to confirm.</small>
                </div>
              </div>
              <div class="oauth-callback-row">
                <input type="text" class="oauth-input" id="oauth-callback-input" placeholder="${escape(session?.redirectUri ?? "http://localhost:1456/oauth-callback")}?code=...&state=..." value="${escape(callbackDraft)}" aria-label="Callback URL">
                <button class="button primary" data-complete-oauth="true" ${busy ? "disabled" : ""}>Complete Login ✓</button>
              </div>
            </div>

            <div class="oauth-status-box ${isError ? "error" : ""}">
              <span class="status-dot"></span>
              <span>${escape(statusMsg)}</span>
            </div>
          </div>
        `
            : `
          <div class="modal-body">
            <div class="oauth-step">
              <div class="oauth-step-header">
                <span class="step-badge">{ }</span>
                <div>
                  <strong>Paste ${escape(names[modalProvider])} credentials JSON</strong>
                  <small>Paste the contents of <code>auth.json</code>, <code>oauth_creds.json</code>, <code>.credentials.json</code>, or an object with <code>access_token</code> and <code>refresh_token</code>.</small>
                </div>
              </div>
              <textarea id="oauth-json-input" class="oauth-textarea" rows="6" placeholder='{"access_token": "...", "refresh_token": "..."}'>${escape(jsonDraft)}</textarea>
              <div class="modal-actions-end">
                <button class="button primary" data-import-json="true" ${busy ? "disabled" : ""}>Import Account ✓</button>
              </div>
            </div>
          </div>
        `
        }
      </div>
    `;
  }

  function renderLimits() {
    const resetEl = document.getElementById("reset-card");
    if (resetEl) {
      resetEl.innerHTML =
        state.resetCredits > 0
          ? `<div class="reset-card"><div><strong>↻ ${state.resetCredits} Codex sıfırlama kredisi</strong><p>Beklemeden uygun bir limiti sıfırlayın. Onay istenir.</p></div><button class="button" data-action="reset">Kredi Kullan</button></div>`
          : "";
    }
  }

  function renderAccountQuotas(account) {
    const wins = account.windows ?? [];
    if (wins.length === 0) {
      if (account.error) {
        return `<div class="saved-account-quotas empty"><span class="quota-err-text">${escape(account.error)}</span></div>`;
      }
      return `<div class="saved-account-quotas empty"><span>Kota bilgisi bekleniyor — yenilemek için ↻ butonuna tıklayın</span></div>`;
    }

    const hasZeroWeekly = wins.some(
      (w) =>
        /week|7d/i.test(w.label) &&
        percent(w.remainingPercent) === 0,
    );

    return `<div class="saved-account-quotas">
      ${wins
        .map((w) => {
          let pct = percent(w.remainingPercent);
          if (hasZeroWeekly && /5\s?[- ]?hour|5h/i.test(w.label)) {
            pct = 0;
          }
          const t = tone(pct);
          return `<div class="mini-quota ${t}">
            <div class="mini-quota-top">
              <span class="mini-quota-label">${escape(w.label)}</span>
              <span class="mini-quota-val"><strong>${pct}%</strong> ${renderProgressRing(pct, t, 13)} <small>↻ ${escape(w.resetLabel)}</small></span>
            </div>
            <progress max="100" value="${pct}"></progress>
          </div>`;
        })
        .join("")}
    </div>`;
  }

  function renderAccounts() {
    document.querySelectorAll("[data-filter]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.filter === accountFilter);
    });

    const filteredAccounts =
      accountFilter === "all"
        ? state.accounts
        : state.accounts.filter((a) => a.provider === accountFilter);

    document.getElementById("account-count").textContent =
      `${filteredAccounts.length} ${filteredAccounts.length === 1 ? "hesap" : "hesap"}`;

    document.getElementById("account-history").innerHTML = filteredAccounts.length
      ? filteredAccounts
          .map((account) => {
            const provider = providerFullNames[account.provider] ?? names[account.provider];
            const badge = account.active ? "● Aktif" : "Hazır";
            const switchBtn = account.active
              ? '<button class="button account-switch" disabled aria-current="true">✓ Aktif Hesap</button>'
              : `<button class="button primary account-switch" data-switch-account="${account.provider}" data-account-id="${account.id}">Hesaba Geç →</button>`;

            return `<article class="saved-account-card ${account.provider}${account.active ? " is-active" : ""}">
              <div class="saved-account-top">
                <span class="provider-symbol">${providerIcon(account.provider)}</span>
                <span class="saved-account-provider">${escape(provider)}</span>
                ${account.plan ? `<span class="plan">${escape(account.plan)}</span>` : ""}
                <span class="pill ${account.active ? "online" : ""}">${badge}</span>
              </div>
              <div class="saved-account-identity">
                <div class="account-avatar">${escape((account.email ?? account.name ?? "?").slice(0, 1).toUpperCase())}</div>
                <div class="saved-account-copy">
                  <h3 title="${escape(account.email)}">${escape(account.email)}</h3>
                  <p>${escape(account.name ? `${account.name} · ` : "")}${escape(account.plan ?? "Oturum")}</p>
                </div>
              </div>
              ${renderAccountQuotas(account)}
              <div class="saved-account-status">
                <span class="status-mark ${account.active ? "active" : "saved"}" aria-hidden="true"></span>
                <span>${account.active ? "Şu an aktif kullanımda" : "Beklemede · Geçişe hazır"}</span>
                <time>${escape(account.updatedAt ? `Güncellendi: ${account.updatedAt}` : `Son görülme: ${dateTime(account.lastSeen)}`)}</time>
              </div>
              <div class="saved-account-actions">
                ${switchBtn}
                <button class="button icon-btn" data-refresh-account="${account.id}" title="${escape(account.email)} kotasını yenile">↻</button>
                <button class="text-button remove-account" data-forget="${account.id}" title="Bu hesabı kaldır">Kaldır</button>
              </div>
            </article>`;
          })
          .join("")
      : '<div class="empty-accounts"><span class="empty-accounts-icon" aria-hidden="true">◎</span><strong>Bu filtrede kayıtlı hesap yok</strong><p>Yetkilendirme bağlantısı ve geri dönüş linkiyle hesap eklemek için yukarıdaki "+ Yeni Hesap Ekle" butonuna tıklayın.</p></div>';
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
      const ringHtml = window
        ? " " +
          renderProgressRing(
            window.remainingPercent,
            s.colorize ? tone(window.remainingPercent) : "",
            14,
          )
        : "";
      const windowText = window
        ? window.remainingPercent +
          "%" +
          ringHtml +
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

  document.addEventListener("input", (event) => {
    if (event.target.id === "oauth-callback-input") {
      callbackDraft = event.target.value;
    } else if (event.target.id === "oauth-json-input") {
      jsonDraft = event.target.value;
    }
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) {
      if (event.target.id === "oauth-modal") {
        closeAddAccountModal();
      }
      return;
    }
    if (button.dataset.section) {
      switchSection(button.dataset.section);
      return;
    }
    if (button.dataset.filter) {
      accountFilter = button.dataset.filter;
      renderAccounts();
      return;
    }
    if (button.dataset.openAdd) {
      openAddAccountModal(button.dataset.openAdd);
      return;
    }
    if (button.dataset.closeModal) {
      closeAddAccountModal();
      return;
    }
    if (button.dataset.modalProvider) {
      modalProvider = button.dataset.modalProvider;
      callbackDraft = "";
      renderOAuthModal();
      send("prepareOAuth", { provider: modalProvider });
      return;
    }
    if (button.dataset.modalTab) {
      modalTab = button.dataset.modalTab;
      renderOAuthModal();
      return;
    }
    if (button.dataset.copyOauth) {
      const url = state?.oauthSession?.authUrl;
      if (url) send("copyText", { text: url });
      return;
    }
    if (button.dataset.openOauth) {
      const url = state?.oauthSession?.authUrl;
      if (url) send("openExternalUrl", { url });
      return;
    }
    if (button.dataset.completeOauth) {
      const inputEl = document.getElementById("oauth-callback-input");
      const callbackUrl = inputEl ? inputEl.value.trim() : callbackDraft.trim();
      send("completeOAuth", {
        sessionId: state?.oauthSession?.sessionId ?? "",
        callbackUrl,
      });
      return;
    }
    if (button.dataset.importJson) {
      const areaEl = document.getElementById("oauth-json-input");
      const rawJson = areaEl ? areaEl.value.trim() : jsonDraft.trim();
      send("importAccountJson", {
        provider: modalProvider,
        rawJson,
      });
      return;
    }
    if (busy) return;
    if (button.dataset.switchAccount)
      send("switchAccount", {
        provider: button.dataset.switchAccount,
        accountId: button.dataset.accountId,
      });
    else if (button.dataset.refreshAccount)
      send("refreshAccount", { accountId: button.dataset.refreshAccount });
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
      if (!data.error && modalOpen && /added|imported/i.test(data.message)) {
        modalOpen = false;
        document.getElementById("oauth-modal").hidden = true;
      }
      return;
    }
    if (data.type !== "state") return;
    const hadSession = !!state?.oauthSession;
    state = data.state;
    busy = data.busy;
    if (hadSession && !state.oauthSession && modalOpen && modalTab === "oauth") {
      // Automatic local callback completed OAuth!
      modalOpen = false;
    }
    renderLimits();
    renderAccounts();
    syncSettings();
    renderOAuthModal();
    document.getElementById("sync-state").textContent = state.refreshing
      ? "Refreshing quotas…"
      : "Multi-account sync active";
    document.getElementById("refresh").disabled = busy || state.refreshing;
    document
      .querySelectorAll(
        "[data-switch-account], [data-refresh-account], [data-forget], [data-action=reset]",
      )
      .forEach((button) => {
        button.disabled = busy || state.refreshing;
      });
  });
  switchSection(section);
  send("ready");
})();
