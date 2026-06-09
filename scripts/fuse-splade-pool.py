#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "onnx>=1.16",
#   "numpy>=1.26",
# ]
# ///
"""
Fuse the SPLADE doc-encoder's activation + masked max-pool into the ONNX graph.

The upstream export (`build-splade-onnx.py`, task=fill-mask) emits a `logits`
output of shape [batch, seq, vocab]. Our Rust `SpladeDocEncoder` then pooled
that on the CPU: relu → masked max over the sequence dim → `log(1+log(1+x))`.

This transform appends those exact ops to the graph and replaces the dense
`logits` output with a `pooled` output of shape [batch, vocab]. Equivalences:

    pooled[b, v] = log(1 + log(1 + max_{s : mask[b,s]==1} relu(logits[b,s,v])))

which matches `splade_pool()` in `crates/futo-notes-inference/src/splade_encoder.rs`
because the activation is monotonic on x>=0, so max(act(x)) == act(max(relu(x))).

Why fuse:
  - The model no longer hands a [batch, seq, 30522] tensor back to the caller;
    it returns [batch, 30522] directly. Far less to copy, and the prerequisite
    for an efficient GPU copy-back later.
  - The pool runs inside ORT (multithreaded / SIMD) instead of a Rust loop.
  - Clean output contract for every consumer / platform.

It does NOT remove the need to sub-batch (`MAX_SEQS_PER_RUN`): the [N,seq,vocab]
tensor still exists as an internal transient feeding the ReduceMax.

Works on any of the variants (int8 / fp32 / fp16): it only appends ops after the
existing fp(16/32) `logits` output, matching that output's element type. For the
int8 dynamic model the quantized matmuls are untouched.

Usage:
  uv run scripts/fuse-splade-pool.py IN.onnx OUT.onnx
"""

from __future__ import annotations

import argparse
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def _find_output(graph: onnx.GraphProto, preferred: str = "logits") -> onnx.ValueInfoProto:
    for o in graph.output:
        if o.name == preferred:
            return o
    if len(graph.output) == 1:
        return graph.output[0]
    names = [o.name for o in graph.output]
    raise SystemExit(f"could not find a '{preferred}' output; outputs were {names}")


def _find_input(graph: onnx.GraphProto, name: str) -> onnx.ValueInfoProto:
    for i in graph.input:
        if i.name == name:
            return i
    names = [i.name for i in graph.input]
    raise SystemExit(f"missing required input '{name}'; inputs were {names}")


def _dims(vi: onnx.ValueInfoProto) -> list:
    out = []
    for d in vi.type.tensor_type.shape.dim:
        out.append(d.dim_param if d.dim_param else d.dim_value)
    return out


def fuse(model: onnx.ModelProto) -> onnx.ModelProto:
    graph = model.graph
    logits = _find_output(graph, "logits")
    _find_input(graph, "attention_mask")  # validate presence

    elem_type = logits.type.tensor_type.elem_type
    if elem_type not in (TensorProto.FLOAT, TensorProto.FLOAT16):
        raise SystemExit(f"unexpected logits dtype {elem_type}; expected float or float16")
    np_dtype = np.float16 if elem_type == TensorProto.FLOAT16 else np.float32

    logits_dims = _dims(logits)
    if len(logits_dims) != 3:
        raise SystemExit(f"expected [batch, seq, vocab] logits, got {logits_dims}")
    batch_dim, _seq_dim, vocab_dim = logits_dims

    src = logits.name  # the tensor name produced by the existing graph

    # Constant initializers for the appended subgraph.
    initializers = [
        numpy_helper.from_array(np.array([1], dtype=np.int64), name="splade_axes_seq"),
        numpy_helper.from_array(np.array([2], dtype=np.int64), name="splade_axes_unsq"),
        numpy_helper.from_array(np.array(1.0, dtype=np_dtype), name="splade_one"),
    ]

    nodes = [
        # relu(logits)
        helper.make_node("Relu", [src], ["splade_relu"], name="splade_relu"),
        # mask: int64 [B,S] -> float [B,S] -> [B,S,1]
        helper.make_node("Cast", ["attention_mask"], ["splade_mask_f"],
                         name="splade_mask_cast", to=elem_type),
        helper.make_node("Unsqueeze", ["splade_mask_f", "splade_axes_unsq"],
                         ["splade_mask_3d"], name="splade_mask_unsqueeze"),
        # zero out masked positions, then max over the sequence dim
        helper.make_node("Mul", ["splade_relu", "splade_mask_3d"], ["splade_masked"],
                         name="splade_mask_mul"),
        helper.make_node("ReduceMax", ["splade_masked", "splade_axes_seq"],
                         ["splade_pooled_max"], name="splade_reduce_max",
                         keepdims=0, noop_with_empty_axes=0),
        # log(1 + log(1 + x))
        helper.make_node("Add", ["splade_pooled_max", "splade_one"], ["splade_add1"],
                         name="splade_add1"),
        helper.make_node("Log", ["splade_add1"], ["splade_log1"], name="splade_log1"),
        helper.make_node("Add", ["splade_log1", "splade_one"], ["splade_add2"],
                         name="splade_add2"),
        helper.make_node("Log", ["splade_add2"], ["pooled"], name="splade_log2"),
    ]

    graph.initializer.extend(initializers)
    graph.node.extend(nodes)

    # Replace the dense [B,S,V] output with the pooled [B,V] output.
    pooled_vi = helper.make_tensor_value_info("pooled", elem_type, [batch_dim, vocab_dim])
    del graph.output[:]
    graph.output.append(pooled_vi)

    try:
        model = onnx.shape_inference.infer_shapes(model)
    except Exception as e:  # quantized graphs sometimes trip shape inference
        print(f"  (shape inference skipped: {e})", file=sys.stderr)
    onnx.checker.check_model(model)
    return model


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", help="input ONNX with a [B,S,vocab] `logits` output")
    ap.add_argument("output", help="where to write the fused [B,vocab] `pooled` model")
    args = ap.parse_args()

    model = onnx.load(args.input)
    before_out = [(o.name, _dims(o)) for o in model.graph.output]
    model = fuse(model)
    after_out = [(o.name, _dims(o)) for o in model.graph.output]
    onnx.save(model, args.output)

    print(f"fused: {args.input} -> {args.output}")
    print(f"  outputs before: {before_out}")
    print(f"  outputs after:  {after_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
