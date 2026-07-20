(function goodosCollapsibleSections() {
  "use strict";

  var COLLAPSED_ROW_LIMIT = 5;
  var MINIMUM_ROWS = COLLAPSED_ROW_LIMIT + 1;
  var scanTimer = 0;
  var regionSequence = 0;

  function directRowCount(table) {
    return Array.from(table.tBodies || []).reduce(function (total, body) {
      return total + body.rows.length;
    }, 0);
  }

  function suitableExistingShell(table) {
    var candidate = table.parentElement;
    if (!candidate) return null;
    if (candidate.matches("[data-goodos-long-table-shell='true']")) return candidate;

    var className = String(candidate.className || "");
    var inlineStyle = String(candidate.getAttribute("style") || "");
    if (/table-wrap|table-shell|table-container/i.test(className) || /overflow\s*:/i.test(inlineStyle)) {
      return candidate;
    }

    return null;
  }

  function shellFor(table) {
    var existing = suitableExistingShell(table);
    if (existing) return existing;

    var shell = document.createElement("div");
    table.parentNode.insertBefore(shell, table);
    shell.appendChild(table);
    return shell;
  }

  function updatePreviewRows(table, collapsed) {
    var rows = Array.from(table.tBodies || []).flatMap(function (body) {
      return Array.from(body.rows);
    });

    rows.forEach(function (row, index) {
      row.classList.toggle("goodos-long-table-preview-hidden", collapsed && index >= COLLAPSED_ROW_LIMIT);
    });
  }

  function setCollapsed(region, collapsed) {
    region.shell.dataset.collapsed = collapsed ? "true" : "false";
    region.button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    region.button.setAttribute("aria-label", collapsed ? "Show all rows" : "Collapse to first 5 rows");
    region.button.querySelector(".goodos-long-table-toggle-label").textContent = collapsed
      ? "Show all rows"
      : "Show first 5 rows";
    region.button.querySelector(".goodos-long-table-toggle-icon").textContent = collapsed ? "+" : "−";
    updatePreviewRows(region.table, collapsed);
  }

  function enhanceTable(table) {
    if (!(table instanceof HTMLTableElement)) return;
    if (table.closest("[data-goodos-long-table-shell='true']") && !table.dataset.goodosLongTablePrimary) return;

    var rowCount = directRowCount(table);
    if (rowCount < MINIMUM_ROWS) return;

    var shell = shellFor(table);
    if (shell.dataset.goodosLongTableShell === "true") {
      var existingCount = shell.previousElementSibling?.querySelector(".goodos-long-table-count");
      var nextCount = rowCount + (rowCount === 1 ? " row" : " rows");
      if (existingCount && existingCount.textContent !== nextCount) {
        existingCount.textContent = nextCount;
      }
      updatePreviewRows(table, shell.dataset.collapsed === "true");
      return;
    }

    regionSequence += 1;
    var regionId = "goodos-long-table-region-" + regionSequence;
    var control = document.createElement("div");
    var button = document.createElement("button");
    var count = document.createElement("span");

    shell.id = regionId;
    shell.classList.add("goodos-long-table-shell");
    shell.dataset.goodosLongTableShell = "true";
    table.dataset.goodosLongTablePrimary = "true";

    control.className = "goodos-long-table-control";
    control.dataset.goodosLongTableControl = "true";
    count.className = "goodos-long-table-count";
    count.textContent = rowCount + (rowCount === 1 ? " row" : " rows");

    button.type = "button";
    button.className = "goodos-long-table-toggle";
    button.setAttribute("aria-controls", regionId);
    button.innerHTML = '<span class="goodos-long-table-toggle-icon" aria-hidden="true"></span>' +
      '<span class="goodos-long-table-toggle-label"></span>';

    control.appendChild(count);
    control.appendChild(button);
    shell.parentNode.insertBefore(control, shell);

    var region = { shell: shell, table: table, button: button };
    setCollapsed(region, true);
    button.addEventListener("click", function () {
      setCollapsed(region, shell.dataset.collapsed !== "true");
    });
  }

  function scanLongTables() {
    var root = document.getElementById("view") || document.body;
    if (!root) return;
    Array.from(root.querySelectorAll("table")).forEach(enhanceTable);
  }

  function scheduleScan() {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scanLongTables, 80);
  }

  function setupMobileNavigation() {
    var sidebar = document.querySelector(".sidebar");
    var brand = sidebar?.querySelector(".brand");
    var nav = sidebar?.querySelector(".nav");
    if (!sidebar || !brand || !nav || brand.querySelector(".goodos-mobile-nav-toggle")) return;

    if (!nav.id) nav.id = "goodos-console-navigation";
    var button = document.createElement("button");
    button.type = "button";
    button.className = "goodos-mobile-nav-toggle";
    button.setAttribute("aria-controls", nav.id);
    button.setAttribute("aria-expanded", "false");
    button.textContent = "Menu";
    sidebar.dataset.mobileMenuOpen = "false";
    brand.appendChild(button);

    function setMenu(open) {
      sidebar.dataset.mobileMenuOpen = open ? "true" : "false";
      button.setAttribute("aria-expanded", open ? "true" : "false");
      button.textContent = open ? "Close" : "Menu";
    }

    button.addEventListener("click", function () {
      setMenu(sidebar.dataset.mobileMenuOpen !== "true");
    });

    nav.addEventListener("click", function (event) {
      if (event.target.closest("button[data-view]") && window.matchMedia("(max-width: 820px)").matches) {
        setMenu(false);
      }
    });
  }

  function initialize() {
    setupMobileNavigation();
    scheduleScan();
    window.setTimeout(scanLongTables, 350);
    window.setTimeout(scanLongTables, 1000);

    var root = document.getElementById("view") || document.body;
    if (root && window.MutationObserver) {
      new MutationObserver(scheduleScan).observe(root, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }

  window.goodosScanLongTables = scanLongTables;
})();
