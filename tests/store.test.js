const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])])
  );
}

function makeContext() {
  let data = {};
  const context = {
    URL,
    console,
    chrome: {
      runtime: { lastError: null },
      storage: {
        local: {
          get(keys, callback) {
            const result = {};
            for (const key of keys) if (key in data) result[key] = structuredClone(data[key]);
            callback(result);
          },
          set(values, callback) {
            // Chromium 내부 저장 표현처럼 객체 키 순서가 달라지는 상황을 재현한다.
            data = { ...data, ...sortObjectKeys(structuredClone(values)) };
            callback();
          },
        },
      },
    },
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "..", "store.js"), "utf8");
  vm.runInContext(source, context);
  return context;
}

test("storageValuesEqual ignores object key order but preserves array order", () => {
  const context = makeContext();
  assert.equal(context.storageValuesEqual(
    { steps: [{ action: "extract", fields: { name: ".name", price: ".price" } }] },
    { steps: [{ fields: { price: ".price", name: ".name" }, action: "extract" }] }
  ), true);
  assert.equal(context.storageValuesEqual(["first", "second"], ["second", "first"]), false);
});

test("saved spec verifies after chrome.storage reorders nested keys", async () => {
  const context = makeContext();
  const spec = {
    steps: [{
      item: ".product",
      fields: { salePrice: ".sale", name: ".name", link: "a@href" },
      action: "extract",
    }],
  };

  const saved = await context.upsertProject({ name: "test", site: "example.com", spec });
  const loaded = await context.getProject(saved.id);

  assert.notEqual(JSON.stringify(loaded.spec), JSON.stringify(spec));
  assert.equal(context.storageValuesEqual(loaded.spec, spec), true);
  assert.equal(context.storageValuesEqual(loaded, saved), true);
});
