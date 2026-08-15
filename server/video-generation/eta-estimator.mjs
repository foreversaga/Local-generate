const MAX_HISTORY_NEIGHBORS = 7;
const MAX_NATIVE_SAMPLES = 12;

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))];
}

function logDistance(left, right) {
  return Math.abs(Math.log(Math.max(0.0001, left / right)));
}

function categoricalPenalty(sampleValue, targetValue) {
  if (!sampleValue || !targetValue) return 0;
  return String(sampleValue) === String(targetValue) ? 0 : 0.75;
}

function adjustedSample(sample, target) {
  const sampleWidth = positive(sample?.width);
  const sampleHeight = positive(sample?.height);
  const sampleDuration = positive(sample?.duration);
  const elapsedMs = positive(sample?.elapsedMs);
  const targetWidth = positive(target?.width);
  const targetHeight = positive(target?.height);
  const targetDuration = positive(target?.duration);
  if (![sampleWidth, sampleHeight, sampleDuration, elapsedMs, targetWidth, targetHeight, targetDuration].every(Boolean)) return null;

  const samplePixels = sampleWidth * sampleHeight;
  const targetPixels = targetWidth * targetHeight;
  const sampleSteps = positive(sample?.steps);
  const targetSteps = positive(target?.steps);
  const pixelRatio = Math.min(4, Math.max(0.25, targetPixels / samplePixels));
  const durationRatio = Math.min(4, Math.max(0.25, targetDuration / sampleDuration));
  const stepRatio = sampleSteps && targetSteps ? Math.min(3, Math.max(1 / 3, targetSteps / sampleSteps)) : 1;
  const predictedMs = elapsedMs * pixelRatio * durationRatio * stepRatio;
  const distance = logDistance(targetPixels, samplePixels)
    + logDistance(targetDuration, sampleDuration)
    + (sampleSteps && targetSteps ? logDistance(targetSteps, sampleSteps) * 0.6 : 0.15)
    + categoricalPenalty(sample.mode, target.mode)
    + categoricalPenalty(sample.modelProfile || sample.model, target.modelProfile || target.model)
    + categoricalPenalty(sample.runtimeMode, target.runtimeMode);
  return { predictedMs, distance };
}

export function estimateHistoricalDuration(samples, target) {
  const candidates = (Array.isArray(samples) ? samples : [])
    .map((sample) => adjustedSample(sample, target))
    .filter(Boolean)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, MAX_HISTORY_NEIGHBORS);
  if (!candidates.length) return null;

  const predicted = candidates.map((candidate) => candidate.predictedMs);
  const durationMs = Math.round(median(predicted));
  const nearestDistance = candidates[0].distance;
  const confidence = candidates.length >= 3 && nearestDistance < 0.45
    ? "high"
    : candidates.length >= 2 && nearestDistance < 1
      ? "medium"
      : "low";
  const spread = confidence === "high" ? 0.12 : confidence === "medium" ? 0.25 : 0.45;
  const observedLower = percentile(predicted, 0.25) ?? durationMs;
  const observedUpper = percentile(predicted, 0.75) ?? durationMs;
  return {
    durationMs,
    lowerMs: Math.max(0, Math.round(Math.min(observedLower, durationMs * (1 - spread)))),
    upperMs: Math.round(Math.max(observedUpper, durationMs * (1 + spread))),
    sampleCount: candidates.length,
    confidence,
    nearestDistance,
  };
}

export function recordNativeProgress(job, current, maximum, atMs = Date.now()) {
  const value = Number(current);
  const max = Number(maximum);
  if (!job || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || !Number.isFinite(atMs)) return;
  const previous = Array.isArray(job.nativeProgressSamples) ? job.nativeProgressSamples : [];
  const last = previous.at(-1);
  if (last && last.current === value && last.maximum === max) return;
  const reset = last && (max !== last.maximum || value < last.current);
  job.nativeProgressSamples = (reset ? [] : previous)
    .concat({ current: Math.max(0, value), maximum: max, atMs })
    .slice(-MAX_NATIVE_SAMPLES);
}

export function estimateNativeRemaining(samples, current, maximum, postprocessMs = 0) {
  const points = Array.isArray(samples) ? samples : [];
  const stepDurations = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const next = points[index];
    const stepDelta = Number(next.current) - Number(previous.current);
    const timeDelta = Number(next.atMs) - Number(previous.atMs);
    if (stepDelta > 0 && timeDelta > 0 && next.maximum === previous.maximum) stepDurations.push(timeDelta / stepDelta);
  }
  if (stepDurations.length < 2) return null;
  const perStepMs = median(stepDurations.slice(-5));
  const remainingSteps = Math.max(0, Number(maximum) - Number(current));
  const remainingMs = Math.max(0, Math.round(perStepMs * remainingSteps + Math.max(0, Number(postprocessMs) || 0)));
  const spread = stepDurations.length >= 4 ? 0.15 : 0.3;
  return {
    remainingMs,
    lowerMs: Math.max(0, Math.round(remainingMs * (1 - spread))),
    upperMs: Math.round(remainingMs * (1 + spread)),
    perStepMs,
    sampleCount: stepDurations.length,
    confidence: stepDurations.length >= 4 ? "high" : "medium",
  };
}

export function combineEta({ historical, native, elapsedMs = 0 } = {}) {
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const historyRemaining = historical ? Math.max(0, historical.durationMs - elapsed) : null;
  if (!native && historyRemaining === null) return null;
  if (!native) {
    const lowerRemaining = Math.max(0, historical.lowerMs - elapsed);
    const upperRemaining = Math.max(lowerRemaining, historical.upperMs - elapsed);
    return { remainingMs: historyRemaining, lowerMs: lowerRemaining, upperMs: upperRemaining, source: "history", confidence: historical.confidence };
  }
  if (historyRemaining === null) return { ...native, source: "native" };
  const nativeWeight = native.sampleCount >= 4 ? 0.8 : 0.65;
  return {
    remainingMs: Math.round(native.remainingMs * nativeWeight + historyRemaining * (1 - nativeWeight)),
    lowerMs: Math.round(native.lowerMs * nativeWeight + Math.max(0, historical.lowerMs - elapsed) * (1 - nativeWeight)),
    upperMs: Math.round(native.upperMs * nativeWeight + Math.max(0, historical.upperMs - elapsed) * (1 - nativeWeight)),
    source: "hybrid",
    confidence: native.confidence === "high" && historical.confidence !== "low" ? "high" : "medium",
  };
}
