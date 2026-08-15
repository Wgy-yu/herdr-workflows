import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Codex Agent Plugin owns user-facing workflow skills", () => {
  const manifest = JSON.parse(readFileSync(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "herdr-workflows");
  assert.equal(manifest.skills, "./skills/");
  assert.match(manifest.interface.shortDescription, /Initialize and run/);
});

test("Herdr plugin remains a runtime bridge without initialization UX", () => {
  const manifest = readFileSync(new URL("../herdr-plugin.toml", import.meta.url), "utf8");
  const actionIds = [...manifest.matchAll(/^id = "([^"]+)"$/gm)].map((match) => match[1]).slice(1);
  assert.deepEqual(actionIds, ["dispatch", "callback", "repair"]);
  assert.doesNotMatch(manifest, /id = "init(?:-|\")/);
  assert.match(manifest, /name = "Herdr Workflows Event Bridge"/);
});
