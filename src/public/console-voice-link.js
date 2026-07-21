(function () {
  "use strict";

  function normalizeDomain(domain) {
    const value = String(domain || "").trim();
    if (!value) return null;
    try {
      const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      return url.protocol === "https:" ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  function injectStyles() {
    if (document.getElementById("goodos-app-launcher-styles")) return;
    const style = document.createElement("style");
    style.id = "goodos-app-launcher-styles";
    style.textContent = `
      .goodos-app-launcher { min-width: 0; }
      .goodos-app-launcher-list { display:grid; gap:4px; max-height:286px; overflow:auto; padding:2px 3px 6px 0; scrollbar-width:thin; }
      .goodos-app-launcher-link { display:flex; align-items:center; gap:10px; min-height:40px; padding:9px 12px; border:1px solid rgba(255,255,255,.07); border-radius:12px; background:rgba(255,255,255,.018); color:#b7bdcb; text-decoration:none; font-size:13px; font-weight:750; transition:background .15s ease,border-color .15s ease,color .15s ease; }
      .goodos-app-launcher-link:hover,.goodos-app-launcher-link:focus-visible { color:#fff; background:rgba(255,255,255,.06); border-color:rgba(123,111,255,.45); outline:none; }
      .goodos-app-launcher-link[data-voice="true"] { min-height:44px; margin-bottom:4px; color:#eef0ff; background:linear-gradient(135deg,rgba(91,82,255,.17),rgba(67,206,219,.08)); border-color:rgba(123,111,255,.32); }
      .goodos-app-launcher-icon { width:23px; height:23px; display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; border-radius:8px; background:#111622; color:#70d7e6; font-size:11px; font-weight:900; text-transform:uppercase; }
      .goodos-app-launcher-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .goodos-app-launcher-state { width:6px; height:6px; margin-left:auto; flex:0 0 auto; border-radius:50%; background:#2bd89b; box-shadow:0 0 8px rgba(43,216,155,.55); }
      .goodos-app-launcher-empty { padding:9px 12px; color:#7f8798; font-size:12px; }
      @media (max-width: 760px) { .goodos-app-launcher-list { max-height:220px; } }
    `;
    document.head.appendChild(style);
  }

  function appLink(app) {
    const href = normalizeDomain(app.domain);
    if (!href) return null;
    const link = document.createElement("a");
    link.className = "goodos-app-launcher-link";
    link.href = href;
    link.rel = "noopener";
    link.title = `Open ${app.name}`;

    const icon = document.createElement("span");
    icon.className = "goodos-app-launcher-icon";
    icon.textContent = String(app.name || "G").replace(/^Good/i, "").trim().charAt(0) || "G";
    const name = document.createElement("span");
    name.className = "goodos-app-launcher-name";
    name.textContent = app.name || app.domain;
    const state = document.createElement("span");
    state.className = "goodos-app-launcher-state";
    state.setAttribute("aria-label", String(app.status || "registered"));
    if (!/^(active|live|online)$/i.test(String(app.status || ""))) {
      state.style.background = "#f5b942";
      state.style.boxShadow = "0 0 8px rgba(245,185,66,.45)";
    }
    link.append(icon, name, state);
    return link;
  }

  async function buildLauncher() {
    injectStyles();
    document.querySelectorAll('[data-goodos-voice-link="true"],.goodos-app-launcher').forEach((node) => node.remove());
    const nav = document.querySelector(".sidebar .nav");
    if (!nav) return;

    const section = document.createElement("div");
    section.className = "nav-section goodos-app-launcher";
    section.setAttribute("aria-label", "GoodOS applications");
    const title = document.createElement("div");
    title.className = "nav-title";
    title.textContent = "Applications";
    const list = document.createElement("div");
    list.className = "goodos-app-launcher-list";

    const voice = document.createElement("a");
    voice.className = "goodos-app-launcher-link";
    voice.href = "/voice";
    voice.dataset.voice = "true";
    voice.dataset.goodosVoiceLink = "true";
    voice.innerHTML = '<span class="goodos-app-launcher-icon" aria-hidden="true">☎</span><span class="goodos-app-launcher-name">GoodOS Voice</span>';
    list.appendChild(voice);
    section.append(title, list);

    const accountSection = Array.from(nav.querySelectorAll(":scope > .nav-section"))
      .find((candidate) => candidate.querySelector(".nav-title")?.textContent.trim().toLowerCase() === "account");
    nav.insertBefore(section, accountSection || null);

    try {
      const response = await fetch("/api/apps", { credentials: "include", cache: "no-store", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Application registry returned ${response.status}`);
      const payload = await response.json();
      const apps = Array.isArray(payload.apps) ? payload.apps : [];
      apps
        .filter((app) => app && app.domain && !/^GoodOS Voice$/i.test(String(app.name || "")))
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
        .forEach((app) => {
          const link = appLink(app);
          if (link) list.appendChild(link);
        });
      if (list.children.length === 1) {
        const empty = document.createElement("div");
        empty.className = "goodos-app-launcher-empty";
        empty.textContent = "No additional applications are registered.";
        list.appendChild(empty);
      }
    } catch (_) {
      const unavailable = document.createElement("div");
      unavailable.className = "goodos-app-launcher-empty";
      unavailable.textContent = "Application registry unavailable.";
      list.appendChild(unavailable);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildLauncher, { once: true });
  else buildLauncher();
})();
