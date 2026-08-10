const BYTES_PER_KIB = 1024;
const BYTES_PER_GIB = 1024 ** 3;

/**
 * ComfyUI has reported GPU memory as bytes, while older health payloads used
 * KiB.  Current values are large enough to distinguish the two representations
 * without changing the API contract: byte values are at least one GiB and KiB
 * values are in the tens of millions.
 */
export function vramToGiB(value, unit = "auto") {
  if (value === undefined || value === null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const bytes = unit === "bytes"
    ? numeric
    : unit === "KiB"
      ? numeric * BYTES_PER_KIB
      : numeric >= BYTES_PER_GIB
        ? numeric
        : numeric * BYTES_PER_KIB;
  return bytes / BYTES_PER_GIB;
}

export function formatVram(value, unit = "auto") {
  const gib = vramToGiB(value, unit);
  return gib === null ? "—" : `${gib.toFixed(1)} GiB`;
}
