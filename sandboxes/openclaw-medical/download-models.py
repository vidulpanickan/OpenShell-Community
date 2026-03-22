# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Download HuggingFace models on first sandbox startup.

Models are downloaded into /sandbox/models/ on the first run. Subsequent
starts skip the download since the files persist on the pod's filesystem.

Uses max_workers=1 to avoid overwhelming the OpenShell proxy with parallel
TLS connections.
"""

import os

# Disable Xet storage protocol — it uses a chunked content-addressable
# transfer mechanism that is incompatible with OpenShell's TLS-terminating
# HTTP CONNECT proxy, causing downloads to crawl at ~77 B/s.
os.environ["HF_HUB_ENABLE_XET"] = "0"

from huggingface_hub import snapshot_download

MODELS_DIR = "/sandbox/models"
os.makedirs(MODELS_DIR, exist_ok=True)

# Medical embedding model (300M parameters)
# https://huggingface.co/vectorranger/embeddinggemma-300m-medical-300k
print("[download-models] Downloading vectorranger/embeddinggemma-300m-medical-300k ...")
snapshot_download(
    "vectorranger/embeddinggemma-300m-medical-300k",
    local_dir=os.path.join(MODELS_DIR, "medical-embedding"),
    max_workers=1,
)
print("[download-models] Medical embedding model ready.")

# --- Placeholder: Entity extraction model ---
# Uncomment and replace REPO_ID with the actual HuggingFace repo:
#
# print("[download-models] Downloading entity extraction model ...")
# snapshot_download(
#     "REPO_ID/entity-extraction-model",
#     local_dir=os.path.join(MODELS_DIR, "entity-extraction"),
# )
# print("[download-models] Entity extraction model ready.")

print("[download-models] All models downloaded successfully.")
