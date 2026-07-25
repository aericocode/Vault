"""
OPUS-MT translation sidecar (SUBTITLES_SPEC 4.2).

Persistent stdin/stdout JSON server, same protocol shape as the whisper
sidecar: loads ONE converted CTranslate2 Marian model (a single language
pair -> en) plus its HF tokenizer, then translates line batches.

Usage: python opus_translate.py <model_dir>
  where model_dir contains the ct2 conversion AND the copied tokenizer files
  (source.spm/target.spm/vocab.json/tokenizer_config.json).

Requests:  {"id": 1, "lines": ["...", "..."]}
           {"command": "shutdown"}
Responses: {"type": "ready"}
           {"type": "result", "id": 1, "lines": ["...", "..."]}
           {"type": "error", "message": "..."}
"""

import sys
import json
import warnings

warnings.filterwarnings("ignore")


def main():
    model_dir = sys.argv[1]

    try:
        import ctranslate2
        from transformers import AutoTokenizer
    except ImportError as e:
        print(json.dumps({"type": "error", "message": f"missing package: {e}"}), flush=True)
        sys.exit(1)

    try:
        device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        translator = ctranslate2.Translator(model_dir, device=device)
        tokenizer = AutoTokenizer.from_pretrained(model_dir)
        print(json.dumps({"type": "ready", "device": device}), flush=True)
    except Exception as e:
        print(json.dumps({"type": "error", "message": str(e)}), flush=True)
        sys.exit(1)

    for line in sys.stdin:
        try:
            request = json.loads(line.strip())
            if request.get("command") == "shutdown":
                break

            req_id = request.get("id", 0)
            lines = request.get("lines", [])

            # Tokenize each line; empty lines pass through untouched
            batch_idx = []
            batch_tokens = []
            for i, text in enumerate(lines):
                text = (text or "").strip()
                if not text:
                    continue
                batch_idx.append(i)
                batch_tokens.append(tokenizer.convert_ids_to_tokens(tokenizer.encode(text)))

            out_lines = list(lines)
            if batch_tokens:
                results = translator.translate_batch(
                    batch_tokens, beam_size=4, max_batch_size=32,
                    max_decoding_length=256,
                )
                for i, res in zip(batch_idx, results):
                    tokens = res.hypotheses[0]
                    ids = tokenizer.convert_tokens_to_ids(tokens)
                    out_lines[i] = tokenizer.decode(ids, skip_special_tokens=True).strip()

            print(json.dumps({"type": "result", "id": req_id, "lines": out_lines}), flush=True)
        except Exception as e:
            rid = 0
            try:
                rid = request.get("id", 0)
            except Exception:
                pass
            print(json.dumps({"type": "result", "id": rid, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
