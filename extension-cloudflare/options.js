// ============================================================
// Gemini Web-Bridge Cloudflare: Options & Diagnostics Page
// ============================================================

(function () {
  "use strict";

  const Settings = (typeof window !== "undefined" && window.GeminiBridgeSettings)
    ? window.GeminiBridgeSettings
    : (typeof GeminiBridgeSettings !== "undefined" ? GeminiBridgeSettings : {
        DEFAULT_WORKER_URL: "https://gemini-web-bridge.taijustarrett417.workers.dev",
        DEFAULT_BRIDGE_SECRET: "gemini-bridge-secret-2026",
        resolveSettings: (s = {}) => ({
          workerUrl: s.workerUrl || "https://gemini-web-bridge.taijustarrett417.workers.dev",
          bridgeToken: s.bridgeToken || "gemini-bridge-secret-2026",
          rawBridgeToken: s.bridgeToken || "",
          enforcementMode: s.enforcementMode === "permissive" ? "permissive" : "strict",
          isDefaultToken: !s.bridgeToken
        })
      });

  const workerUrlInput = document.getElementById("workerUrl");
  const bridgeTokenInput = document.getElementById("bridgeToken");
  const enforcementModeSelect = document.getElementById("enforcementMode");
  const saveBtn = document.getElementById("saveBtn");
  const saveStatus = document.getElementById("saveStatus");
  const testBtn = document.getElementById("testBtn");
  const testStatus = document.getElementById("testStatus");
  const connectionInfo = document.getElementById("connectionInfo");
  const workerInfo = document.getElementById("workerInfo");
  const currentSettings = document.getElementById("currentSettings");

  async function loadSettings() {
    try {
      const result = await chrome.storage.sync.get(["workerUrl", "bridgeToken", "enforcementMode"]);
      const resolved = Settings.resolveSettings(result);

      workerUrlInput.value = result.workerUrl || Settings.DEFAULT_WORKER_URL;
      bridgeTokenInput.value = result.bridgeToken || "";
      enforcementModeSelect.value = resolved.enforcementMode;

      updateCurrentSettingsDisplay(resolved);
    } catch (e) {
      console.error("Failed to load settings:", e);
      workerUrlInput.value = Settings.DEFAULT_WORKER_URL;
      enforcementModeSelect.value = "strict";
    }
  }

  function updateCurrentSettingsDisplay(resolved) {
    const display = {
      workerUrl: resolved.workerUrl,
      bridgeToken: resolved.rawBridgeToken ? "***** (custom token set)" : "(default built-in token)",
      enforcementMode: resolved.enforcementMode,
      protocolVersion: 2,
      capabilities: { verifiedRpc: true }
    };
    currentSettings.textContent = JSON.stringify(display, null, 2);
  }

  function showStatus(el, message, isError = false) {
    el.textContent = message;
    el.className = "status " + (isError ? "error" : "success");
    setTimeout(() => {
      if (el.className.includes("success")) {
        el.className = "status";
      }
    }, 6000);
  }

  async function saveSettings() {
    const workerUrl = workerUrlInput.value.trim();
    const bridgeToken = bridgeTokenInput.value.trim();
    const enforcementMode = enforcementModeSelect.value;

    if (!workerUrl) {
      showStatus(saveStatus, "Worker URL is required.", true);
      return;
    }

    try {
      new URL(workerUrl);
    } catch (e) {
      showStatus(saveStatus, "Invalid Worker URL format. Must include https://", true);
      return;
    }

    try {
      await chrome.storage.sync.set({ workerUrl, bridgeToken, enforcementMode });
      const resolved = Settings.resolveSettings({ workerUrl, bridgeToken, enforcementMode });
      showStatus(saveStatus, "Settings saved successfully.");
      updateCurrentSettingsDisplay(resolved);
    } catch (e) {
      console.error("Failed to save settings:", e);
      showStatus(saveStatus, "Failed to save: " + e.message, true);
    }
  }

  async function testConnection() {
    const workerUrl = workerUrlInput.value.trim() || Settings.DEFAULT_WORKER_URL;
    const bridgeToken = bridgeTokenInput.value.trim();
    const resolved = Settings.resolveSettings({ workerUrl, bridgeToken });

    testBtn.disabled = true;
    testBtn.textContent = "Testing...";
    testStatus.className = "status";
    connectionInfo.style.display = "none";

    try {
      const url = new URL(resolved.workerUrl);
      const authCheckUrl = `${url.origin}/bridge/auth-check`;

      const response = await fetch(authCheckUrl, {
        method: "GET",
        headers: {
          "x-bridge-token": resolved.bridgeToken,
          "Cache-Control": "no-store"
        }
      });

      const body = await response.json().catch(() => ({}));

      if (response.status === 200 && body.ok === true) {
        showStatus(
          testStatus,
          `Connection & Authentication Successful!\n• Protocol Version: ${body.protocolVersion || 2}\n• Status: 200 OK\n• Mode: Authenticated`
        );
        connectionInfo.style.display = "block";
        workerInfo.textContent = JSON.stringify({
          status: "authenticated",
          statusCode: 200,
          protocolVersion: body.protocolVersion || 2,
          tokenType: resolved.isDefaultToken ? "built-in default" : "custom secret",
          endpoint: authCheckUrl
        }, null, 2);
      } else if (response.status === 401) {
        showStatus(
          testStatus,
          "Authentication Failed (401 Unauthorized).\nThe bridge token does not match the Worker's BRIDGE_AUTH_TOKEN.",
          true
        );
        connectionInfo.style.display = "block";
        workerInfo.textContent = JSON.stringify({
          status: "unauthorized",
          statusCode: 401,
          error: "Invalid bridge token",
          endpoint: authCheckUrl
        }, null, 2);
      } else {
        showStatus(
          testStatus,
          `Unexpected Worker Response: HTTP ${response.status} ${response.statusText}`,
          true
        );
        connectionInfo.style.display = "block";
        workerInfo.textContent = JSON.stringify({
          statusCode: response.status,
          response: body,
          endpoint: authCheckUrl
        }, null, 2);
      }
    } catch (e) {
      console.error("Connection test error:", e);
      showStatus(
        testStatus,
        `Connection Failed: ${e.message}. Ensure the Worker URL is online and accessible.`,
        true
      );
      connectionInfo.style.display = "none";
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = "Test Connection";
    }
  }

  const exportEvidenceBtn = document.getElementById("exportEvidenceBtn");
  const infoLabel = document.getElementById("infoLabel");

  async function exportEvidence() {
    try {
      const stored = await chrome.storage.local.get(["gemini_evidence_registry"]);
      const reg = stored?.gemini_evidence_registry || { version: 2, models: {} };
      connectionInfo.style.display = "block";
      if (infoLabel) infoLabel.textContent = "Observed Sanitized Evidence:";
      workerInfo.textContent = JSON.stringify(reg, null, 2);
      showStatus(testStatus, "Exported sanitized structural evidence successfully.");
    } catch (e) {
      showStatus(testStatus, "Failed to export evidence: " + e.message, true);
    }
  }

  saveBtn.addEventListener("click", saveSettings);
  testBtn.addEventListener("click", testConnection);
  if (exportEvidenceBtn) exportEvidenceBtn.addEventListener("click", exportEvidence);

  loadSettings();
})();
