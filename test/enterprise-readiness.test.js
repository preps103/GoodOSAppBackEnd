"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  CONTROL_DEFINITIONS,
  assessDefinition,
  assessEnterpriseReadiness,
} = require("../src/enterprise/enterprise-readiness.service");

const repositoryRoot = path.resolve(__dirname, "..");

test("enterprise program defines exactly nine ordered controls", () => {
  assert.equal(CONTROL_DEFINITIONS.length, 9);
  assert.deepEqual(CONTROL_DEFINITIONS.map((control) => control.step), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(new Set(CONTROL_DEFINITIONS.map((control) => control.id)).size, 9);
});

test("control scoring distinguishes ready, partial, and needs-attention states", () => {
  const definition = {
    id: "example",
    step: 1,
    title: "Example",
    objective: "Example objective",
    files: ["package.json"],
    tables: ["one", "two", "three"],
  };

  assert.equal(
    assessDefinition(definition, new Map([["one", true], ["two", true], ["three", true]]), repositoryRoot).status,
    "ready"
  );
  assert.equal(
    assessDefinition(definition, new Map([["one", true], ["two", true], ["three", false]]), repositoryRoot).status,
    "partial"
  );
  assert.equal(
    assessDefinition(definition, new Map([["one", false], ["two", false], ["three", false]]), repositoryRoot).status,
    "needs_attention"
  );
});

test("readiness assessment reports all nine controls", async () => {
  const queryFn = async (_text, [tables]) => ({
    rows: tables.map((tableName) => ({ tableName, present: true })),
  });
  const report = await assessEnterpriseReadiness({ queryFn, repositoryRoot });

  assert.equal(report.controls.length, 9);
  assert.equal(report.counts.total, 9);
  assert.equal(report.counts.needsAttention, 0);
  assert.match(report.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("source tree contains no disabled or backup JavaScript files", () => {
  const offenders = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      if (entry.isFile() && /\.(?:bak|disabled)(?:\.|$)/i.test(entry.name)) offenders.push(target);
    }
  };
  visit(path.join(repositoryRoot, "src"));
  assert.deepEqual(offenders, []);
});
