import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createLongScriptLibrary,
  handleLongScriptLibraryRoute,
  LongScriptLibraryError,
} from "../server/long-scripts/long-script-library.mjs";

const SHOTS = [
  { id: "shot-1", duration: 3.5, prompt: "subject enters the rainy street", description: "雨夜街道開場遠景" },
  { id: "shot-2", duration: 6, prompt: "subject runs toward the station", description: "角色沿街奔跑的追逐鏡頭" },
];

test("long script library persists shot duration, prompt, and description independently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-long-script-library-"));
  const library = createLongScriptLibrary({
    filePath: path.join(root, "long-scripts.json"),
    idFactory: () => "11111111-1111-4111-8111-111111111111",
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const created = await library.create({ name: "雨夜追逐", shots: SHOTS });
  assert.deepEqual(created.shots, SHOTS);
  const updated = await library.update(created.id, { name: "車站追逐", shots: [{ ...SHOTS[0], duration: 4 }, SHOTS[1]] });
  assert.equal(updated.shots[0].duration, 4);
  assert.equal((await library.list())[0].shots[0].description, "雨夜街道開場遠景");
  assert.match(await readFile(path.join(root, "long-scripts.json"), "utf8"), /"version": 1/);
  await library.remove(created.id);
  assert.deepEqual(await library.list(), []);
});

test("long script library accepts legacy content input but persists prompt semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-long-script-library-legacy-"));
  const library = createLongScriptLibrary({ filePath: path.join(root, "long-scripts.json") });
  const created = await library.create({ name: "Legacy", shots: [
    { duration: 1, content: "prompt one", description: "shot one" },
    { duration: 1, content: "prompt two", description: "shot two" },
  ] });
  assert.equal(created.shots[0].prompt, "prompt one");
  assert.equal(Object.hasOwn(created.shots[0], "content"), false);
});

test("long script library validates complete shots and duplicate names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-long-script-library-validation-"));
  let id = 0;
  const library = createLongScriptLibrary({ filePath: path.join(root, "long-scripts.json"), idFactory: () => `${String(++id).padStart(8, "0")}-1111-4111-8111-111111111111` });
  await assert.rejects(() => library.create({ name: "Incomplete", shots: SHOTS.slice(0, 1) }), (error) => error instanceof LongScriptLibraryError && error.code === "LONG_SCRIPT_INVALID");
  await library.create({ name: "Chase", shots: SHOTS });
  await assert.rejects(() => library.create({ name: "Chase", shots: SHOTS }), (error) => error.code === "LONG_SCRIPT_NAME_EXISTS");
});

test("long script API exposes an isolated CRUD path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-long-script-library-route-"));
  const library = createLongScriptLibrary({ filePath: path.join(root, "long-scripts.json"), idFactory: () => "22222222-2222-4222-8222-222222222222" });
  const calls = [];
  const sendJson = (_res, status, body) => calls.push({ status, body });
  const context = { pathname: "/api/long-scripts", readJson: async () => ({ name: "Route", shots: SHOTS }), sendJson, library };
  assert.equal(await handleLongScriptLibraryRoute({ method: "POST" }, {}, context), true);
  assert.equal(calls[0].status, 201);
  assert.equal(calls[0].body.script.shots[1].prompt, SHOTS[1].prompt);
  assert.equal(await handleLongScriptLibraryRoute({ method: "GET" }, {}, { ...context, readJson: async () => ({}) }), true);
  assert.equal(calls[1].body.scripts[0].name, "Route");
  const id = calls[0].body.script.id;
  assert.equal(await handleLongScriptLibraryRoute({ method: "PUT" }, {}, { ...context, pathname: `/api/long-scripts/${id}`, readJson: async () => ({ name: "Route updated", shots: [{ ...SHOTS[0], description: "updated opening" }, SHOTS[1]] }) }), true);
  assert.equal(calls[2].body.script.name, "Route updated");
  assert.equal(await handleLongScriptLibraryRoute({ method: "DELETE" }, {}, { ...context, pathname: `/api/long-scripts/${id}`, readJson: async () => ({}) }), true);
  assert.equal(calls[3].body.script.id, id);
  assert.equal(await handleLongScriptLibraryRoute({ method: "GET" }, {}, { ...context, pathname: "/api/scripts" }), false);
});
