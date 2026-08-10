import assert from "node:assert/strict";
import test from "node:test";
import { createOllamaCoordinator } from "../server/ollama-coordinator.mjs";

const OLLAMA_URL = "http://ollama.test:11434";
const MODEL = "test-model";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message = "condition was not reached") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

function requestBody(init) {
  return JSON.parse(init.body);
}

function successResponse(value, events = [], label = "response") {
  return {
    ok: true,
    status: 200,
    async text() {
      events.push(`${label}.text:start`);
      events.push(`${label}.text:end`);
      return value;
    },
  };
}

test("generation and unload bodies are fully read before the H3 barrier passes", async () => {
  const generationText = deferred();
  const generationStarted = deferred();
  const unloadText = deferred();
  const events = [];
  const calls = [];
  const coordinator = createOllamaCoordinator({
    fetchImpl: async (url, init) => {
      const body = requestBody(init);
      calls.push({ url: String(url), body, init });
      if (calls.length === 1) {
        generationStarted.resolve();
        return {
          ok: true,
          status: 200,
          async text() {
            events.push("generation.text:start");
            const value = await generationText.promise;
            events.push("generation.text:end");
            return value;
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async text() {
          events.push("unload.text:start");
          const value = await unloadText.promise;
          events.push("unload.text:end");
          return value;
        },
      };
    },
  });

  const generation = coordinator.generate({
    ollamaUrl: OLLAMA_URL,
    model: MODEL,
    body: { prompt: "return the plan", options: { temperature: 0.2 } },
  });
  await generationStarted.promise;
  assert.equal(calls.length, 1, "generation request was not issued");
  const barrier = coordinator.acquireGenerationBarrier();
  await flush();
  assert.equal(calls.length, 1, "barrier must wait for generation body and cleanup");

  generationText.resolve(JSON.stringify({ response: "{\"ok\":true}" }));
  await waitFor(() => calls.length === 2, "model unload was not issued");
  assert.equal(events.includes("generation.text:end"), true);
  assert.equal(events.includes("unload.text:end"), false);
  assert.equal(calls[0].url, `${OLLAMA_URL}/api/generate`);
  assert.equal(calls[0].body.model, MODEL);
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.keep_alive, 0);
  assert.equal(calls[1].url, `${OLLAMA_URL}/api/generate`);
  assert.deepEqual(calls[1].body, { model: MODEL, prompt: "", stream: false, keep_alive: 0 });
  assert.equal(calls.some((call) => call.url.includes("/api/ps")), false);
  assert.equal(calls.some((call) => call.url.endsWith("/stop")), false);

  let barrierSettled = false;
  barrier.then(() => { barrierSettled = true; }, () => { barrierSettled = true; });
  await flush();
  assert.equal(barrierSettled, false, "H3 admission must wait for unload response.text()");

  unloadText.resolve("{}");
  const [result, lease] = await Promise.all([generation, barrier]);
  assert.deepEqual(result.payload, { response: "{\"ok\":true}" });
  assert.equal(events.indexOf("generation.text:end") < events.indexOf("unload.text:start"), true);
  assert.equal(events.indexOf("unload.text:end") >= 0, true);
  lease.release();
});

test("same-tick barrier waiter prevents a pending model admission from penetrating", async () => {
  const generationText = deferred();
  const calls = [];
  const coordinator = createOllamaCoordinator({
    fetchImpl: async (url, init) => {
      const body = requestBody(init);
      calls.push({ url: String(url), body });
      if (body.prompt === "same-tick") {
        return { ok: true, status: 200, text: async () => generationText.promise };
      }
      return successResponse("{}");
    },
  });

  // Both operations are queued in one synchronous turn.  The barrier must
  // win the admission race; the model request may begin only after release.
  const generation = coordinator.generate({ ollamaUrl: OLLAMA_URL, model: MODEL, body: { prompt: "same-tick" } });
  const barrier = coordinator.acquireGenerationBarrier();
  const lease = await barrier;
  assert.equal(calls.length, 0, "a same-tick barrier waiter must block model fetch");

  lease.release();
  await waitFor(() => calls.length === 1, "generation did not start after barrier release");
  assert.equal(calls[0].body.prompt, "same-tick");
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.keep_alive, 0);
  generationText.resolve(JSON.stringify({ response: "ok" }));
  await generation;
  assert.equal(calls.filter((call) => call.body.prompt === "").length, 1);
});

test("parallel same-model generation unloads only after the last lease", async () => {
  const firstText = deferred();
  const secondText = deferred();
  const calls = [];
  const coordinator = createOllamaCoordinator({
    fetchImpl: async (url, init) => {
      const body = requestBody(init);
      calls.push({ url: String(url), body });
      if (body.prompt === "first") {
        return { ok: true, status: 200, text: async () => firstText.promise };
      }
      if (body.prompt === "second") {
        return { ok: true, status: 200, text: async () => secondText.promise };
      }
      return successResponse("{}", [], "unload");
    },
  });

  const first = coordinator.generate({ ollamaUrl: OLLAMA_URL, model: MODEL, body: { prompt: "first" } });
  const second = coordinator.generate({ ollamaUrl: OLLAMA_URL, model: MODEL, body: { prompt: "second" } });
  await waitFor(() => calls.length === 2, "parallel generation requests were not issued");
  firstText.resolve(JSON.stringify({ response: "first" }));
  await first;
  assert.equal(calls.filter((call) => call.body.prompt === "").length, 0, "first lease must not unload a shared model");

  secondText.resolve(JSON.stringify({ response: "second" }));
  await second;
  const unloadCalls = calls.filter((call) => call.body.prompt === "");
  assert.equal(unloadCalls.length, 1);
  assert.equal(unloadCalls[0].body.model, MODEL);
  assert.equal(unloadCalls[0].body.stream, false);
  assert.equal(unloadCalls[0].body.keep_alive, 0);
  assert.equal(calls.every((call) => call.url.endsWith("/api/generate")), true);
});

test("distinct models each receive one scoped unload", async () => {
  const calls = [];
  const coordinator = createOllamaCoordinator({
    fetchImpl: async (url, init) => {
      const body = requestBody(init);
      calls.push({ url: String(url), body });
      return successResponse(JSON.stringify({ response: body.prompt ? body.prompt : "" }));
    },
  });
  await Promise.all([
    coordinator.generate({ ollamaUrl: OLLAMA_URL, model: "model-a", body: { prompt: "a" } }),
    coordinator.generate({ ollamaUrl: OLLAMA_URL, model: "model-b", body: { prompt: "b" } }),
  ]);
  const unloadCalls = calls.filter((call) => call.body.prompt === "");
  assert.deepEqual(unloadCalls.map((call) => call.body.model).sort(), ["model-a", "model-b"]);
  assert.equal(unloadCalls.length, 2);
  assert.equal(calls.some((call) => call.url.includes("/api/ps")), false);
});

test("HTTP and response-text generation failures preserve the primary error and still unload", async (t) => {
  await t.test("HTTP failure", async () => {
    const calls = [];
    const coordinator = createOllamaCoordinator({
      fetchImpl: async (url, init) => {
        const body = requestBody(init);
        calls.push({ url: String(url), body });
        if (calls.length === 1) return { ok: false, status: 502, text: async () => "upstream failed" };
        return successResponse("{}");
      },
    });
    await assert.rejects(
      coordinator.generate({ ollamaUrl: OLLAMA_URL, model: MODEL, body: { prompt: "bad-http" } }),
      (error) => error?.code === "OLLAMA_REQUEST_FAILED" && error?.details?.status === 502,
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.model, MODEL);
    assert.equal(calls[1].body.keep_alive, 0);
  });

  await t.test("generation response body read failure", async () => {
    const calls = [];
    const coordinator = createOllamaCoordinator({
      fetchImpl: async (url, init) => {
        const body = requestBody(init);
        calls.push({ url: String(url), body });
        if (calls.length === 1) {
          return { ok: true, status: 200, text: async () => { throw new Error("generation body read failed"); } };
        }
        return successResponse("{}");
      },
    });
    await assert.rejects(
      coordinator.generate({ ollamaUrl: OLLAMA_URL, model: MODEL, body: { prompt: "bad-text" } }),
      (error) => error?.message === "generation body read failed",
    );
    assert.equal(calls.length, 2, "cleanup must run after a generation body read failure");
    assert.equal(calls[1].body.model, MODEL);
  });

  await t.test("caller parse failure after malformed JSON still follows completed unload", async () => {
    const calls = [];
    const coordinator = createOllamaCoordinator({
      fetchImpl: async (url, init) => {
        const body = requestBody(init);
        calls.push({ url: String(url), body });
        if (calls.length === 1) return successResponse("not valid JSON");
        return successResponse("{}");
      },
    });
    let primaryError;
    try {
      const result = await coordinator.generate({ ollamaUrl: OLLAMA_URL, model: MODEL, body: { prompt: "bad-json" } });
      JSON.parse(result.text);
    } catch (error) {
      primaryError = error;
    }
    assert.match(primaryError?.message || "", /JSON/);
    assert.equal(calls.length, 2, "caller parse failure must not skip model unload");
    assert.equal(calls[1].body.model, MODEL);
    assert.equal(calls[1].body.keep_alive, 0);
  });
});

test("unload failures block H3 submit and report OLLAMA_UNLOAD_FAILED", async (t) => {
  await t.test("unload HTTP failure", async () => {
    const calls = [];
    const coordinator = createOllamaCoordinator({
      fetchImpl: async (url, init) => {
        const body = requestBody(init);
        calls.push({ url: String(url), body });
        if (calls.length === 1) return successResponse(JSON.stringify({ response: "ok" }));
        return { ok: false, status: 500, text: async () => "cannot unload" };
      },
    });
    await assert.rejects(
      coordinator.generate({ ollamaUrl: OLLAMA_URL, model: MODEL, body: { prompt: "ok" } }),
      (error) => error?.code === "OLLAMA_UNLOAD_FAILED" && error?.details?.status === 500,
    );
    let spawned = false;
    const submitH3 = async () => {
      const lease = await coordinator.acquireGenerationBarrier();
      spawned = true;
      lease.release();
    };
    await assert.rejects(submitH3, (error) => error?.code === "OLLAMA_UNLOAD_FAILED" && Array.isArray(error?.details?.failures));
    assert.equal(spawned, false);
    assert.equal(calls.length, 2);
    assert.equal(calls.every((call) => call.url.endsWith("/api/generate")), true);
  });

  await t.test("unload response body read failure", async () => {
    const calls = [];
    const coordinator = createOllamaCoordinator({
      fetchImpl: async (url, init) => {
        const body = requestBody(init);
        calls.push({ url: String(url), body });
        if (calls.length === 1) return successResponse(JSON.stringify({ response: "ok" }));
        return { ok: true, status: 200, text: async () => { throw new Error("unload body read failed"); } };
      },
    });
    await assert.rejects(
      coordinator.generate({ ollamaUrl: OLLAMA_URL, model: MODEL, body: { prompt: "ok" } }),
      (error) => error?.code === "OLLAMA_UNLOAD_FAILED" && /unload body read failed/.test(error?.message || ""),
    );
    let spawned = false;
    await assert.rejects(async () => {
      const lease = await coordinator.acquireGenerationBarrier();
      spawned = true;
      lease.release();
    }, (error) => error?.code === "OLLAMA_UNLOAD_FAILED");
    assert.equal(spawned, false);
    assert.equal(calls.length, 2);
  });
});

test("a held H3 barrier blocks new Ollama admission until release, then recovers", async () => {
  const calls = [];
  const coordinator = createOllamaCoordinator({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: requestBody(init) });
      return successResponse(JSON.stringify({ response: "ok" }));
    },
  });
  const barrier = await coordinator.acquireGenerationBarrier();
  let generationSettled = false;
  const generation = coordinator.generate({ ollamaUrl: OLLAMA_URL, model: MODEL, body: { prompt: "after barrier" } })
    .then(() => { generationSettled = true; });
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(generationSettled, false);
  barrier.release();
  await generation;
  assert.equal(generationSettled, true);
  assert.equal(calls.filter((call) => call.body.prompt === "").length, 1);
});
