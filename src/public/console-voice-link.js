document.addEventListener("DOMContentLoaded", () => {
  // Remove old floating GoodOS Voice button if it exists.
  document.querySelectorAll('[data-goodos-voice-link="true"]').forEach((el) => el.remove());

  const currentPath = window.location.pathname;
  const isVoicePage = currentPath === "/voice" || currentPath === "/voice.html";

  function normalize(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function findMenuText(label) {
    const wanted = normalize(label);

    return Array.from(document.querySelectorAll("a, button, div, span"))
      .find((el) => normalize(el.textContent) === wanted);
  }

  function findBestMenuContainer() {
    const knownLabels = [
      "Project Overview",
      "Table Editor",
      "SQL Editor",
      "Settings",
      "Logs",
      "Backups"
    ];

    for (const label of knownLabels) {
      const found = findMenuText(label);
      if (!found) continue;

      const candidate =
        found.closest("a") ||
        found.closest("button") ||
        found.closest("[role='button']") ||
        found.closest("li") ||
        found.closest("div");

      if (candidate && candidate.parentElement) {
        return {
          parent: candidate.parentElement,
          insertAfter: candidate
        };
      }
    }

    return {
      parent: document.body,
      insertAfter: null
    };
  }

  const existing = Array.from(document.querySelectorAll("a"))
    .find((a) => a.getAttribute("href") === "/voice");

  if (existing) {
    existing.setAttribute("data-goodos-voice-leftnav", "true");
    existing.setAttribute("data-goodos-voice-link", "true");
    existing.textContent = "GoodOS Voice";
    return;
  }

  const { parent, insertAfter } = findBestMenuContainer();

  const link = document.createElement("a");
  link.href = "/voice";
  link.textContent = "GoodOS Voice";
  link.setAttribute("data-goodos-voice-leftnav", "true");
  link.setAttribute("data-goodos-voice-link", "true");

  Object.assign(link.style, {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    minHeight: "44px",
    marginTop: "6px",
    padding: "12px 14px",
    borderRadius: "14px",
    border: isVoicePage ? "1px solid rgba(103,215,255,.45)" : "1px solid rgba(255,255,255,.08)",
    background: isVoicePage
      ? "linear-gradient(135deg, rgba(103,215,255,.18), rgba(168,140,255,.14))"
      : "rgba(255,255,255,.025)",
    color: "#dcecff",
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontWeight: "900",
    fontSize: "13px",
    letterSpacing: ".02em",
    textDecoration: "none",
    boxShadow: isVoicePage ? "0 10px 28px rgba(0,0,0,.22)" : "none"
  });

  const icon = document.createElement("span");
  icon.textContent = "☎";
  Object.assign(icon.style, {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "22px",
    height: "22px",
    borderRadius: "8px",
    background: "rgba(103,215,255,.12)",
    color: "#67d7ff",
    fontSize: "13px",
    flex: "0 0 auto"
  });

  const label = document.createElement("span");
  label.textContent = "GoodOS Voice";

  link.textContent = "";
  link.appendChild(icon);
  link.appendChild(label);

  if (insertAfter && insertAfter.parentElement === parent) {
    insertAfter.insertAdjacentElement("afterend", link);
  } else {
    parent.appendChild(link);
  }
});
