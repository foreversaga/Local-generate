import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Jobs routes use shared adapter and preserve real action endpoints",async()=>{const [list,detail,client]=await Promise.all([readFile(new URL("../app/components/jobs/JobsWorkspace.tsx",import.meta.url),"utf8"),readFile(new URL("../app/components/jobs/JobDetailWorkspace.tsx",import.meta.url),"utf8"),readFile(new URL("../app/components/jobs/job-client.ts",import.meta.url),"utf8")]);assert.match(list,/fetchUnifiedJobs/);assert.match(detail,/performJobAction/);assert.match(client,/\/api\/jobs\/\$\{encodeURIComponent\(job\.id\)\}\/cancel/);assert.match(client,/\/api\/sequences\/\$\{encodeURIComponent\(job\.id\)\}\/\$\{action\}/);assert.match(client,/\/api\/upscale/);assert.match(client,/\/api\/upscale\/jobs\/\$\{encodeURIComponent\(job\.id\)\}\/\$\{action\}/);assert.match(client,/\/api\/img2img\/jobs\/\$\{encodeURIComponent\(job\.id\)\}\/\$\{action\}/)});

test("Jobs progress and filter controls expose accessible values", async () => {
  const [list, detail, styles] = await Promise.all([
    readFile(new URL("../app/components/jobs/JobsWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/jobs/JobDetailWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/jobs/JobsWorkspace.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(list, /role="progressbar"/);
  assert.match(list, /aria-valuenow=\{progress\}/);
  assert.match(detail, /role="progressbar"/);
  assert.match(detail, /aria-valuetext=\{`\$\{progress\}% 已完成`\}/);
  assert.match(styles, /\.filters button\{min-height:44px/);
});

test("Jobs exposes partial status and uses the persisted image batch action", async () => {
  const [list, client] = await Promise.all([
    readFile(new URL("../app/components/jobs/JobsWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/jobs/job-client.ts", import.meta.url), "utf8"),
  ]);
  assert.match(list, /"partial"/);
  assert.match(list, /jobStatusLabel\(status, source\)/);
  assert.match(list, /partial/);
  assert.match(client, /img2img\/jobs\/\$\{encodeURIComponent\(job\.id\)\}\/\$\{action\}/);
});

test("Jobs includes LoRA training collection, actions and safe artifact detail", async () => {
  const [list, detail, client, bridge] = await Promise.all([
    readFile(new URL("../app/components/jobs/JobsWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/jobs/JobDetailWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/jobs/job-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../local-bridge.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(client, /\/api\/lora-training\/jobs/);
  assert.match(client, /lora-training\/jobs\/\$\{encodeURIComponent\(job\.id\)\}\/\$\{action\}/);
  assert.match(list, /sourceLabel\(job\.source\)/);
  assert.match(detail, /router\.replace/);
  assert.match(detail, /job\.artifact\.fileName/);
  assert.match(bridge, /displayName: job\.displayName/);
  assert.match(bridge, /sourceAssets, sourceAssetCount/);
});
