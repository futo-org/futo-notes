#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "optimum[onnxruntime]>=1.23",
#   "transformers>=4.45",
#   "torch>=2.4",
#   "huggingface-hub>=0.24",
#   "onnx>=1.16",
#   "onnxruntime>=1.18",
#   "onnxconverter-common>=1.14",
# ]
# ///
"""
Build the SPLADE doc-encoder ONNX from the canonical Apache 2.0 source.

Source: huggingface.co/opensearch-project/opensearch-neural-sparse-encoding-doc-v3-distill
License: Apache 2.0
Architecture: DistilBERT + MLM head (~67M params)

Outputs two files into a cache directory (default `/tmp/futo-notes-splade-cache/`):
  - splade-model.onnx         (~90 MiB, fp32)
  - splade-tokenizer.json     (~700 KiB)

The cache is keyed by the upstream commit so re-runs are cheap once the
artifact is built. Bumping `--revision` invalidates the cache.

This is the script production should rely on — no community mirror in the
critical path. The orchestrator (`scripts/fetch-splade-model.mjs`) calls
this once per upstream-revision and then copies the artifacts into the
per-platform `gen/{linux,android,apple}/` paths.

Usage:
  uv run scripts/build-splade-onnx.py
  uv run scripts/build-splade-onnx.py --cache-dir /custom/cache
  uv run scripts/build-splade-onnx.py --revision <commit-sha>
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

MODEL_ID = "opensearch-project/opensearch-neural-sparse-encoding-doc-v3-distill"
# Pin to a known-good upstream revision. Update by:
#   1. Verify the new revision still produces a working ONNX with our parity test
#   2. Bump this constant
#   3. Old cache becomes stale (orchestrator will rebuild)
DEFAULT_REVISION = "babf71f3c48695e2e53a978208e8aba48335e3c0"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--cache-dir",
        type=Path,
        default=Path(os.environ.get("TMPDIR", "/tmp")) / "futo-notes-splade-cache",
        help="Where to cache the built ONNX + tokenizer.",
    )
    ap.add_argument(
        "--revision",
        default=DEFAULT_REVISION,
        help="Hugging Face commit sha to pin against. Overridable via env.",
    )
    ap.add_argument("--force", action="store_true", help="Rebuild even if cached.")
    args = ap.parse_args()

    cache_dir: Path = args.cache_dir
    cache_dir.mkdir(parents=True, exist_ok=True)
    out_model = cache_dir / "splade-model.onnx"
    out_model_fp32 = cache_dir / "splade-model-fp32.onnx"
    out_model_fp32_static = cache_dir / "splade-model-fp32-static.onnx"
    out_model_fp16 = cache_dir / "splade-model-fp16.onnx"
    out_tokenizer = cache_dir / "splade-tokenizer.json"
    revision_marker = cache_dir / "revision.txt"

    cached_rev = revision_marker.read_text().strip() if revision_marker.exists() else None
    if (
        not args.force
        and out_model.exists()
        and out_model_fp32.exists()
        and out_model_fp16.exists()
        and out_tokenizer.exists()
        and cached_rev == args.revision
    ):
        print(f"cache hit @ {args.revision[:12]} → {out_model}")
        return 0

    print(f"Building ONNX from {MODEL_ID}@{args.revision[:12]}")
    print("(Apache 2.0; canonical OpenSearch source — no community mirror)")
    print()

    # Late imports so `--help` works without the heavy deps installed yet.
    import onnx
    from huggingface_hub import snapshot_download
    from optimum.exporters.onnx import main_export
    from onnxconverter_common import float16
    from onnxruntime.quantization import quantize_dynamic, QuantType

    with tempfile.TemporaryDirectory(prefix="splade-onnx-build-") as tmp:
        tmp_dir = Path(tmp)
        src_dir = tmp_dir / "src"
        export_dir = tmp_dir / "export"

        # 1. Download just the doc-encoder pieces we need. Skipping the
        #    query_0_SparseStaticEmbedding/ subdir keeps this lean — that
        #    submodule is used by OpenSearch's IDF-weighted query path, which
        #    we don't run (our query path is the simpler binary-presence
        #    tokenize-only mode).
        print(f"  [1/3] Downloading {MODEL_ID} weights → {src_dir.name}/")
        snapshot_download(
            repo_id=MODEL_ID,
            revision=args.revision,
            local_dir=src_dir,
            allow_patterns=[
                "config.json",
                "tokenizer.json",
                "tokenizer_config.json",
                "special_tokens_map.json",
                "vocab.txt",
                "model.safetensors",
            ],
        )

        # 2. Export to ONNX. `task=fill-mask` selects the MLM head so the
        #    exported graph emits a `logits` output of shape [batch, seq,
        #    vocab] — which is what our Rust SpladeDocEncoder reads.
        #    `no_post_process=True` keeps the graph minimal (no extra
        #    softmax/argmax tacked on the output).
        print(f"  [2/4] Exporting to ONNX (fp32) → {export_dir.name}/")
        main_export(
            model_name_or_path=str(src_dir),
            output=export_dir,
            task="fill-mask",
            opset=18,  # distilbert's recommended minimum (avoids opset-17 warning)
            no_post_process=True,
        )
        fp32_path = export_dir / "model.onnx"
        if not fp32_path.exists():
            print(f"ERROR: expected {fp32_path} after export", file=sys.stderr)
            return 1

        # 3. Dynamic INT8 quantization. Reduces the model from ~345 MiB
        #    (fp32) to ~90 MiB with quality loss measured at ~1-2% MRR on
        #    our eval corpus. Weight-only quantization (`QInt8`); activations
        #    stay fp32 at inference. This is what the SPLADE eval validated
        #    and what we need to fit mobile-bundle size budgets.
        print(f"  [3/5] Quantizing to INT8 (dynamic, weight-only)")
        int8_path = export_dir / "model_quantized.onnx"
        quantize_dynamic(
            model_input=str(fp32_path),
            model_output=str(int8_path),
            weight_type=QuantType.QInt8,
        )

        # 4a. Also emit a fixed-shape variant of the fp32 model. CoreML's
        #     MLProgram / ANE refuses dynamic shapes — it specializes the graph
        #     at compile time. We freeze sequence length to 512 (DistilBERT's
        #     max) and keep batch dynamic so the Rust side can batch as before.
        # Use batch=1 + seq=512 fully fixed. CoreML's MLProgram compiler
        # requires every dim to be static — leaving batch dynamic produces
        # MPS shape-inference failures at compile time. The Rust caller pads
        # single chunks to seq=512 and runs one-at-a-time on this model.
        print(f"  [4a/5] Freezing shapes to batch=1, seq=128 for CoreML")
        from onnx.tools import update_model_dims
        fp32_static_path = export_dir / "model_fp32_static.onnx"
        static_model = onnx.load(str(fp32_path))
        update_model_dims.update_inputs_outputs_dims(
            static_model,
            {"input_ids": [1, 128], "attention_mask": [1, 128]},
            {"logits": [1, 128, 30522]},
        )
        onnx.save(static_model, str(fp32_static_path))

        # 4b. Build fp16 alongside int8. CoreML's Neural Engine prefers fp16
        #    and won't accept dynamic-INT8 quantized graphs.
        #
        #    op_block_list keeps the small arithmetic ops (Div for attention
        #    scaling sqrt(d_k), Where, Equal, etc.) in fp32 to avoid mixed-type
        #    errors at load time — converting them produces tensor(float16) /
        #    tensor(float) mismatches that ORT rejects.
        print(f"  [4b/5] Converting to fp16 (for CoreML EP)")
        fp16_path = export_dir / "model_fp16.onnx"
        fp16_model = float16.convert_float_to_float16(
            static_model,
            keep_io_types=True,
            disable_shape_infer=True,
            op_block_list=[
                "ArrayFeatureExtractor", "Binarizer", "CastMap", "CategoryMapper",
                "DictVectorizer", "FeatureVectorizer", "Imputer", "LabelEncoder",
                "LinearClassifier", "LinearRegressor", "Normalizer", "OneHotEncoder",
                "SVMClassifier", "SVMRegressor", "Scaler", "TreeEnsembleClassifier",
                "TreeEnsembleRegressor", "ZipMap", "NonMaxSuppression", "TopK",
                "RoiAlign", "Resize", "Range", "CumSum", "Min", "Max",
                # DistilBERT-specific: keep attention-scaling math in fp32 to avoid
                # type-mismatch at the (fp16 score) / (fp32 sqrt(d_k)) division.
                "Div", "Sqrt",
                # Keep Where/Equal in fp32 — the attention-mask path mixes int and float.
                "Where", "Equal", "Less", "Greater",
            ],
        )
        onnx.save(fp16_model, str(fp16_path))

        # 4c. Patch fp16/fp32 boundary mismatches. `onnxconverter_common.float16`
        #     does not insert Cast nodes at op_block_list boundaries — so the raw
        #     fp16_path output has e.g. `Div(fp16 score, fp32 sqrt(d_k))` and ORT
        #     refuses to load it. The post-pass walks the graph and inserts a
        #     Cast on every disagreeing input. Once fixed, the model loads on
        #     CoreML's ANE at ~110+ notes/sec (vs ~10 on int8 CPU). See
        #     `scripts/patch-fp16-casts.py` for the algorithm.
        print(f"  [4c/5] Patching fp16/fp32 boundary mismatches with Cast nodes")
        patched_fp16_path = export_dir / "model_fp16_patched.onnx"
        _patch_fp16_casts_inline(fp16_path, patched_fp16_path)
        fp16_path = patched_fp16_path

        # 5. Stage into the cache atomically (write to .tmp, then rename).
        print(f"  [5/5] Staging into cache → {cache_dir}/")
        atomic_copy(int8_path, out_model)
        atomic_copy(fp32_path, out_model_fp32)
        atomic_copy(fp32_static_path, out_model_fp32_static)
        atomic_copy(fp16_path, out_model_fp16)
        atomic_copy(src_dir / "tokenizer.json", out_tokenizer)
        revision_marker.write_text(args.revision + "\n")

    sz_model = out_model.stat().st_size / 1024 / 1024
    sz_fp32 = out_model_fp32.stat().st_size / 1024 / 1024
    sz_fp32_st = out_model_fp32_static.stat().st_size / 1024 / 1024
    sz_fp16 = out_model_fp16.stat().st_size / 1024 / 1024
    sz_tok = out_tokenizer.stat().st_size / 1024
    print()
    print(f"  splade-model.onnx              {sz_model:.1f} MiB (int8 dynamic)")
    print(f"  splade-model-fp32.onnx         {sz_fp32:.1f} MiB (fp32 dynamic)")
    print(f"  splade-model-fp32-static.onnx  {sz_fp32_st:.1f} MiB (fp32 seq=512)")
    print(f"  splade-model-fp16.onnx         {sz_fp16:.1f} MiB (fp16 seq=512)")
    print(f"  splade-tokenizer.json          {sz_tok:.1f} KiB")
    print(f"  revision                {args.revision}")
    print()
    print("Done.")
    return 0


def atomic_copy(src: Path, dst: Path) -> None:
    tmp = dst.with_suffix(dst.suffix + ".tmp")
    shutil.copyfile(src, tmp)
    os.replace(tmp, dst)


def _patch_fp16_casts_inline(src: Path, dst: Path) -> None:
    """Run patch-fp16-casts.py against `src`, write to `dst`.

    Imported lazily so `--help` doesn't pay for it. Keeps the patching logic in
    one place (`scripts/patch-fp16-casts.py`) so it can also run standalone.
    """
    import subprocess
    here = Path(__file__).parent
    subprocess.run(
        ["uv", "run", str(here / "patch-fp16-casts.py"), str(src), str(dst)],
        check=True,
    )


if __name__ == "__main__":
    sys.exit(main())
