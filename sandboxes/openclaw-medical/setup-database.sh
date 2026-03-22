#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Create a placeholder SQLite database with a basic medical schema.
# Replace this with your actual data import during Docker build.

set -euo pipefail

DB_DIR="/sandbox/data"
DB_PATH="${DB_DIR}/medical.db"

mkdir -p "$DB_DIR"

sqlite3 "$DB_PATH" <<'SQL'
CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER REFERENCES patients(id),
    document_type TEXT NOT NULL,
    embedding BLOB NOT NULL,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER REFERENCES patients(id),
    entity_type TEXT NOT NULL,
    entity_value TEXT NOT NULL,
    source_document TEXT,
    confidence REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_entities_patient ON entities(patient_id);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_embeddings_patient ON embeddings(patient_id);
SQL

echo "[setup-database] Created ${DB_PATH} with medical schema."
