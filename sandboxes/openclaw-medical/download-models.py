# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Download HuggingFace models at Docker build time.

Models are baked into the image at /sandbox/models/ so they are available
immediately on sandbox startup without runtime HuggingFace network access.
"""

import os
from huggingface_hub import snapshot_download

MODELS_DIR = "/sandbox/models"
os.makedirs(MODELS_DIR, exist_ok=True)

# Medical embedding model (300M parameters)
# https://huggingface.co/vectorranger/embeddinggemma-300m-medical-300k
print("[download-models] Downloading vectorranger/embeddinggemma-300m-medical-300k ...")
snapshot_download(
    "vectorranger/embeddinggemma-300m-medical-300k",
    local_dir=os.path.join(MODELS_DIR, "medical-embedding"),
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
