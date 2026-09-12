function milliseconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

function addMilliseconds(left, right) {
  if (left === null || right === null) return left ?? right;
  return left + right;
}

export function parseSolH3RunnerTiming(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;

  const rows = Array.isArray(report.requests)
    ? report.requests.filter((row) => row && row.status === "PASS")
    : [];
  const formalRow = rows[0] || null;
  const formalGenerationMs = formalRow
    ? milliseconds(formalRow.e2e_s)
    : milliseconds(report.mean_e2e_s);
  const startupAndWarmupMs = milliseconds(report.startup_and_warmup_s);
  if (formalGenerationMs === null && startupAndWarmupMs === null) return null;

  const phaseNames = new Set();
  for (const row of rows) {
    for (const name of Object.keys(row.stage2_phases_s || {})) phaseNames.add(name);
  }
  const stage2PhasesMs = {};
  for (const name of phaseNames) {
    let total = null;
    for (const row of rows) total = addMilliseconds(total, milliseconds(row.stage2_phases_s?.[name]));
    if (total !== null) stage2PhasesMs[name] = total;
  }

  return {
    source: "official-sol-h3-results",
    startupAndWarmupMs,
    formalGenerationMs,
    qwenMs: milliseconds(formalRow?.qwen_s),
    stage1Ms: milliseconds(formalRow?.stage1_s),
    stage2Ms: milliseconds(formalRow?.stage2_s),
    stage2PhasesMs,
    requestCount: rows.length,
  };
}
