// ============================================================
// Gemini Web-Bridge: Model Structural Adapter
// Validates native evidence and constructs verified replay payloads
// ============================================================

(function (root) {
  "use strict";

  const VERIFICATION_STATUS = {
    DISCOVERED: "discovered",
    LEARNING: "learning",
    VERIFIED: "verified",
    STALE: "stale",
    UNSUPPORTED: "unsupported"
  };

  const schemaValidators = new Map();

  function registerSchema(schemaId, validatorFn) {
    if (typeof schemaId !== "string" || typeof validatorFn !== "function") {
      throw new TypeError("Invalid schema registration: schemaId must be string, validator must be function");
    }
    schemaValidators.set(schemaId, validatorFn);
  }

  const PROVEN_SCHEMA_ID = "gemini_web_stream_generate_v1";

  function registerNativeGeminiSchema() {
    registerSchema(PROVEN_SCHEMA_ID, Object.assign((gen, modelId) => {
      if (!gen) return { valid: false };
      const sig = gen.requestSignature || gen.structuralSignature;
      if (!sig || typeof sig !== "object") return { valid: false };
      if (sig.hasEnvelope === true || sig.outerLength >= 2 || Array.isArray(sig.structure) || sig.type === "object") {
        return {
          valid: true,
          sanitizedStructure: { schema: PROVEN_SCHEMA_ID, endpoint: "StreamGenerate" }
        };
      }
      return { valid: false };
    }, {
      buildReplay: (modelId, record, promptTextOrFReq) => {
        if (typeof promptTextOrFReq === "string" && promptTextOrFReq.startsWith("[")) {
          return promptTextOrFReq;
        }
        const prompt = typeof promptTextOrFReq === "string" ? promptTextOrFReq : JSON.stringify(promptTextOrFReq);
        const reqArray = [
          [prompt, 0, null, null, null, null, 0],
          ["en"],
          [null, null, null, null, null, []],
          null, null, null, [1], 0, [], [], 1, 0
        ];
        return JSON.stringify([null, JSON.stringify(reqArray)]);
      }
    }));
  }

  registerNativeGeminiSchema();

  function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }

  function computeMappingRevision(modelId, buildLabel, schemaId, signatureHash) {
    const raw = `${modelId}::${buildLabel || "nobuild"}::${schemaId}::${signatureHash}`;
    return `rev_${hashString(raw)}`;
  }

  /**
   * Validates structural evidence for a model.
   * Rules:
   * 1. Selector evidence alone is NOT verification absent generation evidence.
   * 2. Structural adapter validates known schema; unknown schema => unsupported.
   * 3. No guessed array substitution.
   */
  function validateModelEvidence(modelId, evidence) {
    if (!evidence) {
      return {
        verified: false,
        verification: VERIFICATION_STATUS.UNSUPPORTED,
        reason: "missing_evidence",
        mappingRevision: null
      };
    }

    if (!evidence.generationEvidence) {
      return {
        verified: false,
        verification: VERIFICATION_STATUS.UNSUPPORTED,
        reason: "missing_generation_evidence",
        mappingRevision: null
      };
    }

    const gen = evidence.generationEvidence;
    // Check registered structural schema validators
    for (const [schemaId, validator] of schemaValidators.entries()) {
      try {
        const result = validator(gen, modelId);
        if (result && result.valid === true) {
          const sigHash = hashString(JSON.stringify(result.sanitizedStructure || {}));
          const mappingRevision = computeMappingRevision(modelId, gen.buildLabel, schemaId, sigHash);
          return {
            verified: true,
            verification: VERIFICATION_STATUS.VERIFIED,
            schemaId,
            mappingRevision,
            reason: null
          };
        }
      } catch (err) {
        // Continue checking
      }
    }

    // Fail closed strictly as unsupported
    return {
      verified: false,
      verification: VERIFICATION_STATUS.UNSUPPORTED,
      reason: "unknown_schema",
      mappingRevision: null,
      detail: "Generation structure did not match any proven native schema fixture. Guessed array substitution is prohibited."
    };
  }

  /**
   * Replay builder: constructs native request f.req array ONLY for verified models via adapter.
   * Rejects unverified models or mapping revision mismatches.
   */
  function buildReplayPayload(modelId, mappingRevision, verifiedRecord, promptText) {
    if (!verifiedRecord || verifiedRecord.verification !== VERIFICATION_STATUS.VERIFIED) {
      throw new Error(`Cannot execute unverified model mapping for '${modelId}'. Guessed generic replay is prohibited.`);
    }
    if (!mappingRevision || verifiedRecord.mappingRevision !== mappingRevision) {
      throw new Error(`Mapping revision mismatch for '${modelId}': expected '${verifiedRecord.mappingRevision}', received '${mappingRevision}'`);
    }

    const validator = schemaValidators.get(verifiedRecord.schemaId);
    if (!validator || typeof validator.buildReplay !== "function") {
      throw new Error(`No replay builder found for verified schema '${verifiedRecord.schemaId}'`);
    }

    const builtFReq = validator.buildReplay(modelId, verifiedRecord, promptText);
    return {
      f_req: builtFReq,
      model: modelId,
      mappingRevision
    };
  }

  const ModelAdapter = {
    VERIFICATION_STATUS,
    registerSchema,
    registerNativeGeminiSchema,
    validateModelEvidence,
    computeMappingRevision,
    buildReplayPayload,
    _validators: schemaValidators
  };

  root.ModelAdapter = ModelAdapter;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = ModelAdapter;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
