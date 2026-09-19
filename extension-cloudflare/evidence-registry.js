// ============================================================
// Gemini Web-Bridge: Conservative Evidence Registry
// Protocol v2: Session-Epoch Bound Evidence & Strict Invalidation
// ============================================================

(function (root) {
  "use strict";

  const STORAGE_KEY = "gemini_evidence_registry";
  const REGISTRY_VERSION = 2;

  // Reference ModelAdapter
  const getAdapter = () => (typeof root.ModelAdapter !== "undefined" ? root.ModelAdapter : (typeof require !== "undefined" ? require("./model-adapter.js") : null));

  const PERMITTED_ENDPOINTS = [
    "StreamGenerate",
    "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
    "BatchExecute",
    "/_/BardChatUi/data/batchexecute",
    "ModelSelector"
  ];

  /**
   * Sanitizes evidence strictly:
   * 1. Permits only recognized Gemini endpoint paths, stripping query and userinfo.
   * 2. Trusted model ID is provided as trusted metadata, not inferred from arbitrary payload strings.
   * 3. Never persists arbitrary object keys or prompt strings.
   */
  function sanitizeEvidence(raw = {}) {
    if (!raw || typeof raw !== "object") return null;

    let endpoint = "unknown";
    if (typeof raw.canonicalPath === "string") {
      endpoint = raw.canonicalPath;
    } else if (typeof raw.endpoint === "string") {
      endpoint = raw.endpoint;
    }

    // Verify recognized Gemini paths
    const isPermitted = PERMITTED_ENDPOINTS.some(p => endpoint.includes(p));
    if (!isPermitted) {
      return null;
    }

    const sanitized = {
      endpoint: endpoint.split("?")[0].split("#")[0],
      buildLabel: typeof raw.buildLabel === "string" ? raw.buildLabel.slice(0, 100) : null,
      sessionEpoch: typeof raw.sessionEpoch === "string" ? raw.sessionEpoch : null,
      canonicalModelId: typeof raw.canonicalModelId === "string" ? raw.canonicalModelId : null,
      timestamp: Number.isInteger(raw.timestamp) ? raw.timestamp : Date.now(),
      responseVerified: raw.responseVerified !== false,
      structuralSignature: null
    };

    if (raw.requestSignature && typeof raw.requestSignature === "object") {
      sanitized.structuralSignature = raw.requestSignature;
    } else if (raw.payload && typeof raw.payload === "object") {
      sanitized.structuralSignature = sanitizeStructure(raw.payload);
    }

    return sanitized;
  }

  function sanitizeStructure(val, depth = 0) {
    if (depth > 6) return "max_depth";
    if (val === null) return null;
    if (val === undefined) return undefined;
    if (typeof val === "boolean" || typeof val === "number") return typeof val;

    if (typeof val === "string") {
      return { type: "string", length: val.length };
    }

    if (Array.isArray(val)) {
      return {
        type: "array",
        length: val.length,
        items: val.slice(0, 20).map(item => sanitizeStructure(item, depth + 1))
      };
    }

    if (typeof val === "object") {
      const out = {};
      for (const [k, v] of Object.entries(val).slice(0, 20)) {
        // Drop any sensitive key names
        const lk = k.toLowerCase();
        if (lk.includes("cookie") || lk.includes("token") || lk.includes("auth") ||
            lk.includes("prompt") || lk.includes("response") || lk.includes("snlm0e")) {
          continue;
        }
        out[k] = sanitizeStructure(v, depth + 1);
      }
      return { type: "object", fields: out };
    }

    return typeof val;
  }

  class EvidenceRegistry {
    constructor(storage = null) {
      this.storage = storage || (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? chrome.storage.local : null);
      this.records = new Map();
      this.currentBuildLabel = null;
      this.currentAccountHash = null;
      this.currentSessionEpoch = `epoch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.initialized = false;
    }

    /**
     * Initializes registry from storage.
     * All records loaded from cache are marked STALE and have generationEvidence CLEARED.
     * Cached generation evidence can never be revived across restarts or sessions.
     */
    async init(currentBuildLabel = null, currentAccountHash = null) {
      this.currentBuildLabel = currentBuildLabel;
      this.currentAccountHash = currentAccountHash;
      this.currentSessionEpoch = `epoch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.records.clear();

      if (!this.storage) {
        this.initialized = true;
        return;
      }

      try {
        const stored = await new Promise((resolve) => {
          this.storage.get([STORAGE_KEY], (res) => resolve(res?.[STORAGE_KEY] || null));
        });

        if (stored && stored.version === REGISTRY_VERSION && stored.records) {
          const buildChanged = this.currentBuildLabel && stored.lastBuildLabel && this.currentBuildLabel !== stored.lastBuildLabel;
          const accountChanged = this.currentAccountHash && stored.lastAccountHash && this.currentAccountHash !== stored.lastAccountHash;

          for (const [modelId, record] of Object.entries(stored.records)) {
            const invalidatedReason = buildChanged ? "build_label_changed" : (accountChanged ? "account_changed" : null);
            // Must clear generationEvidence on load so it cannot be revived by selector evidence
            this.records.set(modelId, {
              modelId,
              verification: "stale",
              mappingRevision: null,
              selectorEvidence: null,
              generationEvidence: null,
              invalidatedReason,
              updatedAt: Date.now()
            });
          }
        }
      } catch (e) {
        console.warn("[EvidenceRegistry] Error loading from storage:", e);
      }

      this.initialized = true;
    }

    /**
     * Updates session identifiers and invalidates mappings if build or account changed.
     * When a new session epoch is provided, it is preserved during invalidation so
     * that evidence recorded with the same epoch is not dropped.
     */
    updateSession(buildLabel, accountHash, sessionEpoch = null) {
      const buildChanged = this.currentBuildLabel && buildLabel && this.currentBuildLabel !== buildLabel;
      const accountChanged = this.currentAccountHash && accountHash && this.currentAccountHash !== accountHash;

      if (sessionEpoch && sessionEpoch !== this.currentSessionEpoch) {
        this.currentSessionEpoch = sessionEpoch;
      }

      this.currentBuildLabel = buildLabel || this.currentBuildLabel;
      this.currentAccountHash = accountHash || this.currentAccountHash;

      if (buildChanged || accountChanged) {
        this.invalidateAll(buildChanged ? "build_label_changed" : "account_changed", sessionEpoch);
      }
    }

    /**
     * Invalidates all model records in registry.
     * Rigorous invalidation: Clears generation evidence, resets revisions, marks stale.
     * @param {string} reason - Why invalidation occurred
     * @param {string|null} preserveEpoch - If provided, use this epoch instead of generating a new one.
     *   This allows evidence recorded with the same epoch to succeed after invalidation.
     */
    invalidateAll(reason = "session_invalidated", preserveEpoch = null) {
      this.currentSessionEpoch = preserveEpoch || `epoch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      for (const [modelId, record] of this.records.entries()) {
        this.records.set(modelId, {
          modelId,
          verification: "stale",
          mappingRevision: null,
          selectorEvidence: null,
          generationEvidence: null, // CLEAR generation evidence completely
          invalidatedReason: reason,
          updatedAt: Date.now()
        });
      }
      this.saveToStorage();
    }

    /**
     * Records selector evidence observed for a model.
     * Rule: Selector evidence alone CANNOT verify a model and CANNOT revive old generation evidence.
     */
    recordSelectorEvidence(modelId, rawEvidence) {
      const sanitized = sanitizeEvidence(rawEvidence);
      const existing = this.records.get(modelId) || {
        modelId,
        verification: "discovered",
        mappingRevision: null,
        selectorEvidence: null,
        generationEvidence: null
      };

      existing.selectorEvidence = sanitized;
      existing.updatedAt = Date.now();

      // Forbid selector-only revalidation: never set to verified here!
      if (existing.verification === "verified" && !existing.generationEvidence) {
        existing.verification = "stale";
        existing.mappingRevision = null;
      }

      this.records.set(modelId, existing);
      this.saveToStorage();
      return existing;
    }

    /**
     * Records native generation evidence observed for a model.
     * Only valid when bound to the current session epoch and response is verified.
     */
    recordGenerationEvidence(modelId, rawEvidence) {
      const sanitized = sanitizeEvidence(rawEvidence);
      if (!sanitized) return null;

      // Evidence must be bound to current session epoch
      if (sanitized.sessionEpoch && sanitized.sessionEpoch !== this.currentSessionEpoch) {
        console.warn("[EvidenceRegistry] Dropping evidence from mismatched session epoch");
        return null;
      }

      // If response is explicitly marked unverified, drop
      if (rawEvidence && rawEvidence.responseVerified === false) {
        return null;
      }

      const existing = this.records.get(modelId) || {
        modelId,
        verification: "discovered",
        mappingRevision: null,
        selectorEvidence: null,
        generationEvidence: null
      };

      existing.generationEvidence = sanitized;
      existing.sessionEpoch = this.currentSessionEpoch;
      existing.updatedAt = Date.now();

      const adapter = getAdapter();
      if (adapter) {
        const validation = adapter.validateModelEvidence(modelId, existing);
        existing.verification = validation.verification;
        existing.mappingRevision = validation.mappingRevision;
        existing.schemaId = validation.schemaId || null;
      } else {
        existing.verification = "unsupported";
        existing.mappingRevision = null;
      }

      this.records.set(modelId, existing);
      this.saveToStorage();
      return existing;
    }

    setLearning(modelId) {
      const existing = this.records.get(modelId) || {
        modelId,
        verification: "discovered",
        mappingRevision: null,
        selectorEvidence: null,
        generationEvidence: null
      };
      existing.verification = "learning";
      existing.updatedAt = Date.now();
      this.records.set(modelId, existing);
      return existing;
    }

    setUnsupported(modelId, reason = "unverified") {
      const existing = this.records.get(modelId) || {
        modelId,
        verification: "discovered",
        mappingRevision: null,
        selectorEvidence: null,
        generationEvidence: null
      };
      existing.verification = "unsupported";
      existing.mappingRevision = null;
      existing.unsupportedReason = reason;
      existing.generationEvidence = null; // Clear unverified evidence
      existing.updatedAt = Date.now();
      this.records.set(modelId, existing);
      this.saveToStorage();
      return existing;
    }

    getModelStatus(modelId) {
      const record = this.records.get(modelId);
      if (!record) {
        return { verification: "discovered", mappingRevision: null };
      }
      return {
        verification: record.verification || "discovered",
        mappingRevision: record.mappingRevision || null,
        record
      };
    }

    enrichDiscoveredModels(discoveredList) {
      return (Array.isArray(discoveredList) ? discoveredList : []).map(m => {
        const status = this.getModelStatus(m.id);
        return {
          id: m.id,
          name: m.name,
          description: m.description || "",
          thinking: m.thinking === true,
          verification: status.verification,
          mapping_revision: status.mappingRevision
        };
      });
    }

    /**
     * Diagnostic export of observed structural signatures without prompts or tokens.
     */
    exportSanitizedEvidence() {
      const exportData = {
        version: REGISTRY_VERSION,
        sessionEpoch: this.currentSessionEpoch,
        buildLabel: this.currentBuildLabel,
        models: {}
      };

      for (const [id, rec] of this.records.entries()) {
        exportData.models[id] = {
          verification: rec.verification,
          mappingRevision: rec.mappingRevision,
          schemaId: rec.schemaId || null,
          hasGenerationEvidence: Boolean(rec.generationEvidence),
          generationSignature: rec.generationEvidence?.structuralSignature || null,
          updatedAt: rec.updatedAt
        };
      }

      return exportData;
    }

    async saveToStorage() {
      if (!this.storage) return;

      const recordsObj = {};
      for (const [id, rec] of this.records.entries()) {
        recordsObj[id] = {
          modelId: rec.modelId,
          verification: rec.verification,
          mappingRevision: rec.mappingRevision,
          schemaId: rec.schemaId || null,
          updatedAt: rec.updatedAt || Date.now()
        };
      }

      const payload = {
        version: REGISTRY_VERSION,
        lastBuildLabel: this.currentBuildLabel,
        lastAccountHash: this.currentAccountHash,
        records: recordsObj
      };

      try {
        await new Promise((resolve) => {
          this.storage.set({ [STORAGE_KEY]: payload }, () => resolve());
        });
      } catch (e) {
        console.warn("[EvidenceRegistry] Error saving to storage:", e);
      }
    }
  }

  root.EvidenceRegistry = EvidenceRegistry;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { EvidenceRegistry, sanitizeEvidence, sanitizeStructure };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
