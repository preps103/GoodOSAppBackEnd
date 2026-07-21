const assert =
  require("node:assert/strict");

const fs =
  require("node:fs");

const path =
  require("node:path");

const test =
  require("node:test");

const root =
  path.resolve(
    __dirname,
    ".."
  );

function read(file) {
  return fs.readFileSync(
    path.join(root, file),
    "utf8"
  );
}

test(
  "Phase 2 installs protected automatic GraphQL",
  () => {
    const migration =
      read(
        "migrations/20260721_goodbase_graphql_phase2.sql"
      );

    const routes =
      read(
        "src/routes/graphql.routes.js"
      );

    const index =
      read(
        "src/routes/index.js"
      );

    assert.match(
      migration,
      /CREATE EXTENSION pg_graphql/
    );

    assert.match(
      migration,
      /backend_graphql_operation_logs/
    );

    assert.match(
      migration,
      /REVOKE ALL[\s\S]*ON SCHEMA graphql/
    );

    assert.match(
      routes,
      /SET LOCAL ROLE goodos_authenticated/
    );

    assert.match(
      routes,
      /goodos_auth\.check_session/
    );

    assert.match(
      routes,
      /GOODBASE_GRAPHQL_DEPTH_LIMIT/
    );

    assert.match(
      routes,
      /GOODBASE_GRAPHQL_COMPLEXITY_LIMIT/
    );

    assert.match(
      routes,
      /GOODBASE_GRAPHQL_INTROSPECTION_DISABLED/
    );

    assert.match(
      index,
      /"\/graphql\/v1"/
    );
  }
);

test(
  "Phase 2 GraphQL analyzer enforces limits",
  () => {
    process.env.JWT_SECRET =
      process.env.JWT_SECRET ||
      "goodbase-phase2-test-secret-long-enough";

    const {
      analyzeGraphQL,
      queryHash,
    } =
      require(
        "../src/routes/graphql.routes"
      ).__test;

    const metrics =
      analyzeGraphQL(
        `
          query Demo {
            demo_itemsCollection {
              edges {
                node {
                  id
                }
              }
            }
          }
        `,
        "Demo",
        {
          maxDepth: 10,
          maxComplexity: 20,
          maxAliases: 5,
        }
      );

    assert.equal(
      metrics.operationType,
      "query"
    );

    assert.match(
      queryHash(
        "query { __typename }"
      ),
      /^[a-f0-9]{64}$/
    );

    assert.throws(
      () =>
        analyzeGraphQL(
          "query { a { b { c } } }",
          null,
          {
            maxDepth: 2,
            maxComplexity: 100,
            maxAliases: 10,
          }
        ),
      /depth limit/
    );
  }
);
