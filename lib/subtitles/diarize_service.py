"""
Speaker diarization sidecar (SUBTITLES_SPEC 4.4).

Persistent stdin/stdout JSON server, same protocol shape as the whisper and
OPUS-MT sidecars: loads the diarization models once, then labels speaker
turns in audio files (16 kHz mono wav — the pipeline's extracted audio).

Default backend is sherpa-onnx (pyannote segmentation-3.0 + 3D-Speaker CAM++
embeddings, both ONNX): CPU-only, no HuggingFace account/token, ungated model
files. A 'pyannote' backend exists for the full pyannote.audio pipeline
(better on overlapping speech) but needs `pip install pyannote.audio` plus an
HF token with the gated models accepted — see SUBTITLES_SPEC 4.4.

Usage: python diarize_service.py <backend> <model_dir>
  sherpa model_dir must contain:
    segmentation-pyannote-3.0.onnx
    embedding-3dspeaker-campplus-zh_en.onnx

Requests:  {"id": 1, "filepath": "...wav", "num_speakers": -1, "threshold": 0.5}
           {"command": "shutdown"}
Responses: {"type": "ready", "backend": "sherpa"}
           {"type": "progress", "id": 1, "pct": 42}          (sherpa backend, ~2% steps)
           {"type": "result", "id": 1, "turns": [{"start": s, "end": s, "speaker": "0"}]}
           {"type": "error", "message": "..."}
"""

import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")


def load_sherpa(model_dir):
    import sherpa_onnx

    seg = os.path.join(model_dir, "segmentation-pyannote-3.0.onnx")
    emb = os.path.join(model_dir, "embedding-3dspeaker-campplus-zh_en.onnx")
    for p in (seg, emb):
        if not os.path.exists(p):
            raise FileNotFoundError(f"missing diarization model: {p}")

    # Intra-op ONNX threads. Embedding extraction is the long pole on speech-
    # dense audio and parallelizes well; scale with the box (DIARIZE_THREADS
    # overrides). Segmentation windows are cheaper — half the budget.
    try:
        _threads = int(os.environ.get("DIARIZE_THREADS", "") or 0)
    except ValueError:
        _threads = 0
    if _threads <= 0:
        _threads = max(4, min(8, (os.cpu_count() or 4) // 2))

    def diarize(filepath, num_speakers=-1, threshold=0.5, progress=None):
        import soundfile as sf

        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            clustering=sherpa_onnx.FastClusteringConfig(
                num_clusters=int(num_speakers) if num_speakers and int(num_speakers) > 0 else -1,
                # `threshold if None` (not `threshold or`) so an explicit 0.0
                # (max-split) survives instead of falling back to 0.5
                threshold=float(threshold if threshold is not None else 0.5),
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=emb, num_threads=_threads),
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg),
                num_threads=max(2, _threads // 2),
            ),
            min_duration_on=0.3,
            min_duration_off=0.5,
        )
        if not config.validate():
            raise RuntimeError("invalid sherpa-onnx diarization config")
        sd = sherpa_onnx.OfflineSpeakerDiarization(config)

        audio, sr = sf.read(filepath, dtype="float32", always_2d=True)
        audio = audio[:, 0]
        if sr != sd.sample_rate:
            # pipeline audio is always 16k; resample defensively for other callers
            import numpy as np
            idx = (np.arange(int(len(audio) * sd.sample_rate / sr)) * (sr / sd.sample_rate)).astype("int64")
            audio = audio[idx.clip(max=len(audio) - 1)]

        # Chunk-level progress (throttled to 2% steps) so the Node side can show
        # a live % while the pipeline waits on this pass. Older sherpa-onnx
        # builds lack the callback kwarg — fall back to the silent call.
        result = None
        if progress is not None:
            last = [-1]

            def _cb(done, total, *_):
                pct = int(done * 100 / total) if total else 0
                if pct - last[0] >= 2 or (pct == 100 and last[0] != 100):
                    last[0] = pct
                    progress(pct)
                return 0

            try:
                result = sd.process(audio, callback=_cb)
            except TypeError:
                result = None
        if result is None:
            result = sd.process(audio)
        result = result.sort_by_start_time()
        return [
            {"start": round(r.start, 3), "end": round(r.end, 3), "speaker": str(r.speaker)}
            for r in result
        ]

    return diarize


def load_pyannote(_model_dir):
    # Optional high-accuracy backend: pip install pyannote.audio, then accept the
    # gated pyannote/segmentation-3.0 + pyannote/speaker-diarization-3.1 models on
    # HF and set HF_TOKEN. Untested until those prerequisites exist on this box.
    import torch
    from pyannote.audio import Pipeline

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    pipe = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=token)
    device = os.environ.get("DIARIZE_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
    pipe.to(torch.device(device))

    def diarize(filepath, num_speakers=-1, threshold=None, progress=None):
        kwargs = {}
        if num_speakers and int(num_speakers) > 0:
            kwargs["num_speakers"] = int(num_speakers)
        diar = pipe(filepath, **kwargs)
        return [
            {"start": round(turn.start, 3), "end": round(turn.end, 3), "speaker": str(label)}
            for turn, _, label in diar.itertracks(yield_label=True)
        ]

    return diarize


def main():
    backend = sys.argv[1] if len(sys.argv) > 1 else "sherpa"
    model_dir = sys.argv[2] if len(sys.argv) > 2 else "."

    try:
        diarize = load_pyannote(model_dir) if backend == "pyannote" else load_sherpa(model_dir)
        print(json.dumps({"type": "ready", "backend": backend}), flush=True)
    except Exception as e:
        print(json.dumps({"type": "error", "message": str(e)}), flush=True)
        sys.exit(1)

    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line.strip())
            if request.get("command") == "shutdown":
                break
            req_id = request.get("id", 0)
            turns = diarize(
                request["filepath"],
                num_speakers=request.get("num_speakers", -1),
                threshold=request.get("threshold", 0.5),
                progress=lambda pct: print(
                    json.dumps({"type": "progress", "id": req_id, "pct": pct}), flush=True),
            )
            print(json.dumps({"type": "result", "id": req_id, "turns": turns}), flush=True)
        except Exception as e:
            rid = request.get("id", 0) if isinstance(request, dict) else 0
            print(json.dumps({"type": "result", "id": rid, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
