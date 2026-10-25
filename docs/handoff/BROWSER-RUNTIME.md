# Browser runtime (E1): reproducibility notes

Embedding prerequisite for the browser mesh participant slice. This covers
getting the pinned reference model to execute in a real hardware-enabled
Chrome. It is not full plugin delivery.

## Tested launch (separate temporary profile)

Root verified with a throwaway Chrome 155 profile (NOT the user's main
profile, NOT an extension install):

```sh
/usr/bin/google-chrome --user-data-dir=/tmp/vortex-chrome-test-profile \
  --no-sandbox --disable-setuid-sandbox --disable-gpu-sandbox \
  --enable-unsafe-webgpu --ignore-gpu-blocklist \
  --enable-features=Vulkan,WebMachineLearningNeuralNetwork \
  --use-angle=vulkan --use-vulkan=native
```

The `--no-sandbox` / `--disable-*-sandbox` flags are test-harness-only
settings for this disposable diagnostic profile. They are not requirements
for installing or running the eventual extension, and must not be presented
as such.

## Bench server and run

```sh
bun bench/serve.ts   # prints http://127.0.0.1:8787/
```

Reference run (pinned q4 on WebGPU, 3 samples):

```text
http://127.0.0.1:8787/?local=1&devices=webgpu&dtypes=q4&runs=3
```

One backend per fresh page: the page defaults to a single backend (webgpu
when an adapter is present, else wasm). An explicit `devices=` list is still
honored, but the installed library's inference-session factory
(`src/backends/onnx.js` in the dependency, not modified here) chains backend
init without recovering a rejection, so the first load/warmup/inference
failure poisons later loader calls in the same page. The benchmark records
that first real error, disposes the model, marks all later requested rows
SKIPPED/NOT ATTEMPTED, and reports stopped status — repeated identical
errors in one page must not be read as independent provider evidence, and a
fresh-page WebGPU pass (16 vectors) stands while a poisoned-page WebGPU row
does not refute it. There is no automatic runtime fallback. Root tests
fresh-page providers separately.

For `local=1`, the page serves the ORIGINAL installed cache same-origin
through the existing bench server and fails closed (no Hugging Face
fallback, no browser model cache):

```text
node_modules/@huggingface/transformers/.cache/onnx-community/embeddinggemma-2-ONNX/
  config.json  tokenizer.json  tokenizer_config.json
  onnx/model_q4.onnx  onnx/model_q4.onnx_data
```

Local integrity record (measured 2026-10-14; the model blobs are matched
against the canonical hashes below, not copied anywhere):

```text
8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d  config.json
4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4  tokenizer.json
17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874  tokenizer_config.json
model_q4.onnx 490742 bytes; model_q4.onnx_data 174028800 bytes
```

Nothing is copied, symlinked, or created inside the repo for local mode; no
untracked giant files. In particular,
`/tmp/vortex-browser-model-probe/onnx-community/embeddinggemma-2-ONNX` is
the EXPANDED-GATHER THROWAWAY WASM build, NOT the original canonical q4,
and must never be presented or served as the reference model. Root's raw
GPU test used the original alias, separate from the converted build.

Without `local=1` the page downloads the pinned revision from Hugging Face.

## Actual hardware evidence (not API presence)

- Real non-fallback WebGPU adapter: AMD gcn4; minimal compute shader
  returned the expected result 42.
- WebGL1/2 contexts reported AMD Vulkan renderers with correct readPixels.
- A WASM module returned 42; shared memory and cross-origin isolation were
  available. This does not by itself demonstrate threaded model execution.
- WebNN API context creation succeeded (context only, see below). Root
  additionally ran a tiny add graph on each requested cpu/gpu/npu device:
  each `[1,2]+itself` returned `[2,4]`. A requested device string is not
  proof of a physical NPU.
- Pinned q4 reference model executed on WebGPU with no model conversion.
  Initial 3-text raw-runtime probe: finite 768-dim vectors, maxAbs <= 1.35e-7,
  cosine > 0.9999999999997, inference 283-537 ms.
- The actual VORTEX embedder, including its browser-bundled Transformers
  runtime (rechecked with current Bun 1.4.3), passed 16 native comparisons: multilingual, code, empty,
  whitespace and longer input. Every output was finite and 768-dimensional;
  maximum component error 2.384185791015625e-7, minimum cosine
  0.999999999999371. Profile ID stayed
  `4652a98d5577c41ff3d819c14300a742f6cc2ce94f4eb899e13a723d9c06849f`.
  Longest measured inference was 1.95 seconds. This is a hardware AMD
  discrete-GPU test, not an Intel integrated-GPU test.

Enabled API/context is distinguished from working inference throughout:
WebGL context presence and WebNN context creation do NOT prove the
installed ONNX model executes there, and are not advertised as such.

## Known limits (do not overclaim)

- Sixteen fixed parity inputs on one GPU/driver/runtime combination are
  limited evidence. Broader device coverage, calibrated matching thresholds,
  and first-download/extension lifecycle acceptance remain separate work.
- WebNN gpu/cpu model initialization FAILS (GatherBlockQuantized provider).
- Original WASM model execution FAILS on the same missing op.
- A throwaway expanded-Gather build ran on WASM with near-identical vectors,
  but it is NOT a production fallback, changes the weight build, and is not
  validated broadly. Weight/profile/namespace must not be silently changed.
- Alternate dtype builds in the benchmark are labeled alternate, never
  reference acceptance.

## Canonical data integrity

- Original canonical data SHA256
  `c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49`
  matches the pinned Hugging Face revision response `x-linked-etag`.
- Metadata hash
  `f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9`.

## Packaging note

Browser runtime model assets are data. Extension JS/WASM must bundle
locally; nothing here may pull code at runtime. This repository stays
private.
