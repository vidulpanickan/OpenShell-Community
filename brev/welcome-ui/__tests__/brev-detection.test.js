// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import serverModule from '../server.js';
const { extractBrevId, maybeDetectBrevId, buildOpenclawUrl, _resetForTesting, PORT } = serverModule;

// === TC-B01 through TC-B10: Brev ID detection and URL building ===

describe("extractBrevId", () => {
  it("TC-B01: extracts ID from 80810-abcdef123.brevlab.com", () => {
    expect(extractBrevId("80810-abcdef123.brevlab.com")).toBe("abcdef123");
  });

  it("TC-B02: extracts ID from 8080-xyz.brevlab.com", () => {
    expect(extractBrevId("8080-xyz.brevlab.com")).toBe("xyz");
  });

  it("TC-B03: localhost:8081 returns empty string", () => {
    expect(extractBrevId("localhost:8081")).toBe("");
  });

  it("TC-B04: non-matching host returns empty string", () => {
    expect(extractBrevId("example.com")).toBe("");
    expect(extractBrevId("")).toBe("");
    expect(extractBrevId("some.other.domain")).toBe("");
  });
});

describe("maybeDetectBrevId + buildOpenclawUrl", () => {
  beforeEach(() => {
    _resetForTesting();
  });

  function makeReq(host, forwardedProto = null, forwardedHost = null) {
    const headers = { host };
    if (forwardedProto) headers["x-forwarded-proto"] = forwardedProto;
    if (forwardedHost) headers["x-forwarded-host"] = forwardedHost;
    return { headers };
  }

  it("TC-B05: detection is idempotent (once set, never overwritten)", () => {
    maybeDetectBrevId("80810-first-id.brevlab.com");
    maybeDetectBrevId("80810-second-id.brevlab.com");
    const url = buildOpenclawUrl(null);
    expect(url).toContain("first-id");
    expect(url).not.toContain("second-id");
  });

  it("TC-B06: request host takes priority when deriving URL", () => {
    const req = makeReq("sandbox-preview.example.net", "https");
    expect(buildOpenclawUrl(null, req)).toBe("https://sandbox-preview.example.net/");
  });

  it("TC-B07: forwarded host/proto are honored for external URL building", () => {
    const req = makeReq("127.0.0.1:8081", "https", "80810-myenv.brevlab.com");
    expect(buildOpenclawUrl("tok123", req)).toBe(
      "https://80810-myenv.brevlab.com/#token=tok123"
    );
  });

  it("TC-B08: with Brev ID fallback, URL uses https://80810-{id}.brevlab.com/", () => {
    maybeDetectBrevId("80810-myenv.brevlab.com");
    expect(buildOpenclawUrl(null)).toBe("https://80810-myenv.brevlab.com/");
  });

  it("TC-B09: with Brev ID fallback + token, URL appends fragment token", () => {
    maybeDetectBrevId("80810-myenv.brevlab.com");
    expect(buildOpenclawUrl("tok123")).toBe(
      "https://80810-myenv.brevlab.com/#token=tok123"
    );
  });

  it("TC-B10: without request context or Brev ID, URL falls back to local 127.0.0.1", () => {
    const url = buildOpenclawUrl(null);
    expect(url).toBe(`http://127.0.0.1:${PORT}/`);
  });

  it("TC-B11: detected Brev ID still supplies fallback when request context is absent", () => {
    maybeDetectBrevId("80810-detected.brevlab.com");
    const url = buildOpenclawUrl(null);
    expect(url).toContain("detected");
  });

  it("TC-B12: buildOpenclawUrl still uses welcome-ui port family, not gateway port family", () => {
    maybeDetectBrevId("80810-env123.brevlab.com");
    const url = buildOpenclawUrl(null);
    expect(url).toContain("80810");
    expect(url).not.toContain("8080-");
  });
});
