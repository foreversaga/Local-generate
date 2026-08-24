from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "h3-latent-generate.py"
SPEC = importlib.util.spec_from_file_location("h3_latent_generate", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class LatentCheckpointDirectoryTest(unittest.TestCase):
    def test_converts_save_prefix_to_load_directory(self) -> None:
        self.assertEqual(
            MODULE._latent_checkpoint_directory("h3_sequence_checkpoints/seq-test/clip"),
            "h3_sequence_checkpoints/seq-test",
        )

    def test_normalizes_windows_separators(self) -> None:
        self.assertEqual(
            MODULE._latent_checkpoint_directory(r"h3_sequence_checkpoints\seq-test\clip"),
            "h3_sequence_checkpoints/seq-test",
        )

    def test_rejects_a_bare_prefix(self) -> None:
        with self.assertRaisesRegex(ValueError, "must include a folder"):
            MODULE._latent_checkpoint_directory("clip")


if __name__ == "__main__":
    unittest.main()
