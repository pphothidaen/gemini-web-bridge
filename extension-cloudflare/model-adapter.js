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

  /**
   * Registry of proven native schema validators.
   * NOTE: In production, there are no proven native Gemini web RPC fixtures in this repo.
   * Safe adapter API is functional under unit fixtures, but fails closed for unknown schemas.
   */
  const schemaValidators = new Map();

  function registerSchema(schemaId, validatorFn) {
    if (typeof schemaId !== "string" || typeof validatorFn !== "function") {
      throw new TypeError("Invalid schema registration: schemaId must be string, validator must be function");
    }
    schemaValidators.set(schemaId, validatorFn);
  }

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
