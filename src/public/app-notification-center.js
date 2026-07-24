(function () {
  "use strict";
  const appId = "goodbase";
  if (!appId || appId === "all") throw new Error("A fixed notification app ID is required.");
  const root = document.createElement("section");
  root.id = "goodbaseNotificationCenter";
  root.hidden = true;
  root.setAttribute("aria-label", "GoodBase notification center");
  root.innerHTML = `
    <style>
      #goodbaseNotificationCenter{position:fixed;z-index:95;right:24px;top:70px;width:min(430px,calc(100vw - 32px));height:min(680px,calc(100vh - 96px));display:flex;flex-direction:column;overflow:hidden;border:1px solid #2b3040;border-radius:20px;background:#111319;color:#eef1f7;box-shadow:0 24px 70px #0009}#goodbaseNotificationCenter[hidden]{display:none}
      .gn-head,.gn-tools,.gn-foot{padding:14px;border-bottom:1px solid #ffffff14}.gn-head,.gn-foot,.gn-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.gn-tools{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}.gn-tools input{grid-column:1/-1}.gn-tools input,.gn-tools select{min-width:0;border:1px solid #ffffff1c;border-radius:8px;background:#191c24;color:#e5e7eb;padding:8px}.gn-list{min-height:0;flex:1;overflow:auto}.gn-item{padding:14px;border-bottom:1px solid #ffffff0f}.gn-item.read{opacity:.58}.gn-item p{margin:6px 0;color:#aab1c0;font-size:12px}.gn-item small{color:#7d8596;text-transform:uppercase}.gn-item button,.gn-head button,.gn-foot button,.gn-foot a{border:0;background:none;color:#9ba8ff;cursor:pointer;font:inherit}.gn-actions{display:flex;gap:12px;margin-top:9px;font-size:12px}.gn-state{padding:32px;text-align:center;color:#8b93a3}.gn-error{margin:10px;padding:10px;border-radius:8px;background:#ef444422;color:#fca5a5}.gn-bulk{grid-column:1/-1;display:flex;justify-content:space-between}
    </style>
    <div class="gn-head"><div><strong>Notifications</strong><div style="font-size:11px;color:#8b93a3">GoodBase only</div></div><button data-refresh>Refresh</button></div>
    <div class="gn-tools"><input data-search placeholder="Search notifications…" aria-label="Search notifications"><select data-status><option value="all">All status</option><option value="unread">Unread</option><option value="read">Read</option></select><select data-category><option value="all">All categories</option></select><select data-severity><option value="all">All severity</option></select><div class="gn-bulk"><button data-read-all>Mark all read</button><button data-archive-read>Archive read</button></div></div>
    <div data-error></div><div class="gn-list" data-list></div>
    <div class="gn-foot"><span data-total>0 total</span><span><button data-prev>Previous</button> <span data-page>1 / 1</span> <button data-next>Next</button></span><a href="/account/notifications?appId=goodbase">Preferences</a></div>`;
  document.body.appendChild(root);
  const state = { items: [], page: 1, size: 8, loading: false };
  const $ = selector => root.querySelector(selector);
  const endpoint = suffix => `/api/notifications/apps/${encodeURIComponent(appId)}${suffix}`;
  const request = async (suffix, options) => {
    const response = await fetch(endpoint(suffix), { credentials: "same-origin", headers: { Accept: "application/json", ...(options && options.body ? { "Content-Type": "application/json" } : {}) }, ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || "Notification request failed.");
    return body.data || body;
  };
  const safeAction = value => { try { const url = new URL(value, location.origin); return ["http:", "https:"].includes(url.protocol) && (url.origin === location.origin || url.hostname === "goodos.app" || url.hostname.endsWith(".goodos.app")) ? url : null; } catch { return null; } };
  const filtered = () => {
    const query = $("[data-search]").value.trim().toLowerCase(), status = $("[data-status]").value, category = $("[data-category]").value, severity = $("[data-severity]").value;
    return state.items.filter(item => {
      const read = item.isRead === true || item.status === "read";
      return (!query || `${item.title || ""} ${item.message || ""} ${item.category || ""}`.toLowerCase().includes(query)) && (status === "all" || (status === "read" ? read : !read)) && (category === "all" || item.category === category) && (severity === "all" || item.severity === severity);
    });
  };
  const render = () => {
    const items = filtered(), pages = Math.max(1, Math.ceil(items.length / state.size)); state.page = Math.min(state.page, pages);
    const slice = items.slice((state.page - 1) * state.size, state.page * state.size);
    $("[data-page]").textContent = `${state.page} / ${pages}`; $("[data-total]").textContent = `${state.items.length} total`; $("[data-prev]").disabled = state.page <= 1; $("[data-next]").disabled = state.page >= pages;
    $("[data-list]").innerHTML = state.loading ? '<div class="gn-state">Loading notifications…</div>' : slice.length ? slice.map(item => {
      const read = item.isRead === true || item.status === "read", action = safeAction(item.actionUrl);
      return `<article class="gn-item ${read ? "read" : ""}" data-id="${safeText(item.id)}"><div class="gn-row"><strong>${safeText(item.title || "Notification")}</strong><small>${safeText(item.severity || "info")}</small></div><p>${safeText(item.message || "")}</p><small>${safeText(item.category || "GoodBase")}</small><div class="gn-actions"><button data-read="${read ? "false" : "true"}>${read ? "Mark unread" : "Mark read"}</button><button data-archive>Archive</button>${action ? `<button data-open="${safeText(action.href)}">Open</button>` : ""}</div></article>`;
    }).join("") : '<div class="gn-state">No matching notifications.</div>';
  };
  const load = async () => { state.loading = true; render(); try { const data = await request("/overview"); state.items = Array.isArray(data.notifications) ? data.notifications : []; $("[data-error]").innerHTML = ""; const fill = (selector, values) => { const select = $(selector), first = select.options[0].outerHTML; select.innerHTML = first + [...new Set(values.filter(Boolean))].map(value => `<option>${safeText(value)}</option>`).join(""); }; fill("[data-category]", state.items.map(x => x.category)); fill("[data-severity]", state.items.map(x => x.severity)); } catch (error) { $("[data-error]").innerHTML = `<div class="gn-error">${safeText(error.message)} <button data-retry>Retry</button></div>`; } finally { state.loading = false; render(); } };
  const mutate = async (suffix, options) => { try { await request(suffix, options); await load(); } catch (error) { $("[data-error]").innerHTML = `<div class="gn-error">${safeText(error.message)}</div>`; } };
  root.addEventListener("click", event => {
    const button = event.target.closest("button"); if (!button) return;
    if (button.matches("[data-refresh],[data-retry]")) void load();
    else if (button.matches("[data-read-all]")) void mutate("/read-all", { method: "POST" });
    else if (button.matches("[data-archive-read]")) void mutate("/archive-read", { method: "POST" });
    else if (button.matches("[data-prev]")) { state.page--; render(); } else if (button.matches("[data-next]")) { state.page++; render(); }
    else { const item = button.closest("[data-id]"), id = item && item.dataset.id; if (id && button.matches("[data-read]")) void mutate(`/${encodeURIComponent(id)}/read`, { method: "PATCH", body: JSON.stringify({ isRead: button.dataset.read === "true" }) }); if (id && button.matches("[data-archive]")) void mutate(`/${encodeURIComponent(id)}`, { method: "DELETE" }); if (button.dataset.open) window.open(button.dataset.open, "_blank", "noopener,noreferrer"); }
  });
  root.addEventListener("input", () => { state.page = 1; render(); }); root.addEventListener("change", () => { state.page = 1; render(); });
  window.addEventListener("goodbase:notifications", () => { root.hidden = !root.hidden; if (!root.hidden) void load(); });
  document.addEventListener("click", event => { if (!root.hidden && !root.contains(event.target) && !event.target.closest("#notificationsBtn")) root.hidden = true; });
  setInterval(() => { if (!root.hidden && document.visibilityState === "visible") void load(); }, 30000);
})();
