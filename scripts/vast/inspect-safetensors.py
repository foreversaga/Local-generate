from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


def inspect(path: Path) -> dict[str, object]:
    tensor_digest = hashlib.sha256()
    with path.open("rb") as handle:
        header_length = int.from_bytes(handle.read(8), "little")
        header = json.loads(handle.read(header_length))
    tensors = {name: value for name, value in header.items() if name != "__metadata__"}
    declared_data_length = max(
        int(value["data_offsets"][1]) for value in tensors.values()
    )
    with path.open("rb") as handle:
        handle.seek(8 + header_length)
        remaining = declared_data_length
        while remaining:
            chunk = handle.read(min(8 * 1024 * 1024, remaining))
            if not chunk:
                break
            tensor_digest.update(chunk)
            remaining -= len(chunk)
        trailing = handle.read()
    return {
        "path": str(path),
        "size": path.stat().st_size,
        "header_length": header_length,
        "metadata": header.get("__metadata__"),
        "tensor_count": len(tensors),
        "declared_data_length": declared_data_length,
        "trailing_length": len(trailing),
        "trailing_hex": trailing.hex(),
        "trailing_text": trailing.decode("utf-8", errors="replace"),
        "tensor_names_sha256": hashlib.sha256(
            "\n".join(sorted(tensors)).encode("utf-8")
        ).hexdigest(),
        "tensor_data_sha256": tensor_digest.hexdigest(),
    }


if __name__ == "__main__":
    print(json.dumps(inspect(Path(sys.argv[1])), sort_keys=True))
