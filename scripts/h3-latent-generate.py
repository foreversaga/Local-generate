"""Run the existing MiniMax H3 CLI with crash-safe latent continuation nodes."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
H3_ROOT = Path(r"C:\Users\forev\minimax-h3-local")
H3_SRC = H3_ROOT / "src"


def _wrapper_args(argv: list[str]) -> tuple[argparse.Namespace, list[str]]:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--latent-checkpoint-prefix", required=True)
    parser.add_argument("--latent-clip-index", type=int, required=True)
    parser.add_argument("--latent-previous-clip-index", type=int)
    parser.add_argument("--latent-context-frames", type=int, default=39)
    return parser.parse_known_args(argv)


def _replace_duration(argv: list[str], duration: float) -> list[str]:
    forwarded = list(argv)
    try:
        index = forwarded.index("--duration")
    except ValueError:
        forwarded.extend(["--duration", str(duration)])
    else:
        if index + 1 >= len(forwarded):
            raise ValueError("--duration requires a value")
        forwarded[index + 1] = str(duration)
    return forwarded


def _nearest_h3_frame_count(requested_frames: int) -> int:
    """Nearest complete H3 clip length on the native 17k+5 grid."""
    lower_k = max(0, (requested_frames - 5) // 17)
    candidates = (17 * lower_k + 5, 17 * (lower_k + 1) + 5)
    return min(candidates, key=lambda value: (abs(value - requested_frames), -value))


def _continuation_frame_count(requested_frames: int) -> int:
    """Nearest new-content length that stays phase-aligned after 39-frame trim."""
    return max(17, int((requested_frames + 8) // 17) * 17)


def _next_node_id(graph: dict[str, dict]) -> str:
    return str(max((int(node_id) for node_id in graph if str(node_id).isdigit()), default=0) + 1)


def _node_id(graph: dict[str, dict], class_type: str) -> str:
    matches = [node_id for node_id, node in graph.items() if node.get("class_type") == class_type]
    if len(matches) != 1:
        raise RuntimeError(f"Expected one {class_type} node, found {len(matches)}")
    return matches[0]


def main(argv: list[str] | None = None) -> int:
    options, forwarded = _wrapper_args(list(sys.argv[1:] if argv is None else argv))
    if options.latent_clip_index < 1:
        raise ValueError("latent clip index must be at least 1")
    if options.latent_context_frames < 5:
        raise ValueError("latent context must be at least 5 frames")
    if options.latent_clip_index > 1 and options.latent_previous_clip_index != options.latent_clip_index - 1:
        raise ValueError("latent continuation must load the immediately preceding clip")

    try:
        duration_index = forwarded.index("--duration")
        delivered_duration = float(forwarded[duration_index + 1])
    except (ValueError, IndexError) as exc:
        raise ValueError("latent generation requires a valid --duration") from exc

    # A starter must end on the native 17k+5 grid. A continuation's delivered
    # portion must be 17k frames, because adding the protected 39-frame prefix
    # then lands the raw request back on 17k+5. The sequence runner uses the
    # same calculation and preserves this exact native endpoint.
    delivered_frames = max(5, round(delivered_duration * 24))
    if options.latent_clip_index == 1:
        raw_frames = _nearest_h3_frame_count(delivered_frames)
    else:
        raw_frames = _continuation_frame_count(delivered_frames) + options.latent_context_frames
    if raw_frames < 5 or raw_frames % 17 != 5:
        raise ValueError("latent duration does not land on the H3 17k+5 frame grid")
    raw_duration = raw_frames / 24.0
    forwarded = _replace_duration(forwarded, raw_duration)

    sys.path.insert(0, str(H3_ROOT))
    sys.path.insert(0, str(H3_SRC))
    import generate as generator  # noqa: PLC0415

    original_build = generator.build_api_prompt

    def build_latent_prompt(*args, **kwargs):
        graph = original_build(*args, **kwargs)
        sampler_id = _node_id(graph, "SamplerCustomAdvanced")
        video_decode_id = _node_id(graph, "VAEDecode")
        audio_decode_id = _node_id(graph, "VAEDecodeAudio")
        create_video_id = _node_id(graph, "CreateVideo")

        save_id = _next_node_id(graph)
        graph[save_id] = {
            "class_type": "MiniMaxH3CheckpointSave",
            "inputs": {
                "latent": [sampler_id, 0],
                "filename_prefix": options.latent_checkpoint_prefix,
                "clip_index": options.latent_clip_index,
            },
        }
        graph[video_decode_id]["inputs"]["samples"] = [save_id, 0]
        graph[audio_decode_id]["inputs"]["samples"] = [save_id, 0]

        if options.latent_clip_index > 1:
            load_id = _next_node_id(graph)
            graph[load_id] = {
                "class_type": "MiniMaxH3CheckpointLoad",
                "inputs": {
                    "checkpoint_path": options.latent_checkpoint_prefix,
                    "clip_index": options.latent_previous_clip_index,
                },
            }
            context_id = _next_node_id(graph)
            conditioning_id = _node_id(graph, "MiniMaxH3ReferenceToVideo")
            graph[context_id] = {
                "class_type": "MiniMaxH3GeneratedAVMaskedContext",
                "inputs": {
                    "latent": [conditioning_id, 1],
                    "source_latent": [load_id, 0],
                    "context_length": options.latent_context_frames,
                },
            }
            graph[sampler_id]["inputs"]["latent_image"] = [context_id, 0]

            trim_id = _next_node_id(graph)
            graph[trim_id] = {
                "class_type": "MiniMaxH3MotionContextTrim",
                "inputs": {
                    "images": [video_decode_id, 0],
                    "trim_frames": [context_id, 1],
                    "audio": [audio_decode_id, 0],
                    "fps": 24.0,
                    "match_tail": True,
                    "video_crossfade_frames": 1,
                },
            }
            graph[create_video_id]["inputs"]["images"] = [trim_id, 0]
            graph[create_video_id]["inputs"]["audio"] = [trim_id, 1]
        return graph

    generator.build_api_prompt = build_latent_prompt
    return generator.run(generator.parse_args(forwarded))


if __name__ == "__main__":
    raise SystemExit(main())
