// Classification of Gemini replies that are NOT a real answer.
//
// Why this module exists
// ----------------------
// A Gemini refusal arrives as an ordinary `result` in a 200 MCP response. The
// old check in scripts/ask-each-skill.mjs looked only for
// "not ready | disconnected | please log in | unavailable" in the text, so
// every refusal scored as a PASS. The bridge reported success while Gemini was
// answering "I'm having a hard time fulfilling your request."
//
// The three classes are kept apart on purpose: they need different remedies.
//   • upstreamError — Gemini itself failed. Retrying usually helps; it is not
//     the prompt's fault, so do not rewrite the prompt.
//   • softRefusal  — Gemini declined but stayed polite. A native re-ask (the
//     UI retry button) is worth trying; the payload is fine.
//   • hardRefusal  — a safety policy declined. Re-asking the same thing will
//     decline again, so the retry budget must not be spent here.
//
// `As an AI` is deliberately NOT a hard-refusal marker on its own. Gemini
// writes "As an AI language model, I don't have personal opinions..." in
// perfectly usable answers, so matching it alone produced false positives.

// Exact strings captured from production responses (v4.4.3) plus the stable
// family of variants Gemini uses for the same outcomes.
const UPSTREAM_ERROR = [
  /I encountered an error/i,
  /I seem to be encountering an error/i,
  /something went wrong/i,
  /internal error/i,
  /could you try again/i,
  // Observed in production (4.6.0 / 4.7.0): Gemini leaked its own system
  // preamble instead of answering. It arrives as a *successful* 200 with real
  // text, so nothing else caught it — but "I only have the task of generating
  // text" is not an answer and must not score as one. Two distinct phrasings
  // have now been seen, on the app chat and on the notebook respectively, so
  // both are matched; the general shape is "I was not given a <program> to
  // do this" rather than anything about the user's question.
  /อยู่นอกเหนือขอบเขต(ของ)?โปรแกรมที่(ฉัน|ผม)มี/i,
  /ฉันมีหน้าที่สร้างข้อความเท่านั้น/i,
  /ผมมีหน้าที่สร้างข้อความเท่านั้น/i,
  /ฉันไม่ได้รับการโปรแกรมมาให้ทำเรื่องนี้/i,
  /outside the scope of (my|the) program/i,
  /my only (task|role) is (to )?(generating|produce)( text)?/i,
  /I (was not|wasn't) (given|provided with) (a|the) program/i,
  /no program (to|was) (handle|do|perform)/i
];

const SOFT_REFUSAL = [
  /hard time fulfilling/i,
  /help you with something else/i,
  /can I help you with something else/i,
  /can I try something else/i
];

const HARD_REFUSAL = [
  /I can'?t help (with )?that/i,
  /I cannot (help|assist|provide|comply)/i,
  /I'?m sorry,? but I (can'?t|cannot|am unable)/i,
  /against my (guidelines|policy)/i,
  /violates? (our|my) (usage )?policy/i
];

export const REFUSAL_KIND = {
  ANSWERED: "answered",
  UPSTREAM_ERROR: "upstream_error",
  SOFT_REFUSAL: "soft_refusal",
  HARD_REFUSAL: "hard_refusal"
};

function matchesAny(text, patterns) {
  return patterns.some((re) => re.test(text));
}

/**
 * Classify a Gemini reply.
 *
 * Order matters. "hard time fulfilling ... Can I help you with something
 * else" is a soft refusal, but the same family of replies can also contain
 * "could you try again"; upstream errors are checked first because they
 * describe a transport-level failure rather than a decision.
 *
 * @param {string} text
 * @returns {{kind: string, matched: string|null}}
 */
export function classifyGeminiReply(text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) {
    return { kind: REFUSAL_KIND.ANSWERED, matched: null };
  }

  if (matchesAny(value, UPSTREAM_ERROR)) {
    return { kind: REFUSAL_KIND.UPSTREAM_ERROR, matched: "upstream_error" };
  }
  if (matchesAny(value, SOFT_REFUSAL)) {
    return { kind: REFUSAL_KIND.SOFT_REFUSAL, matched: "soft_refusal" };
  }
  if (matchesAny(value, HARD_REFUSAL)) {
    return { kind: REFUSAL_KIND.HARD_REFUSAL, matched: "hard_refusal" };
  }
  return { kind: REFUSAL_KIND.ANSWERED, matched: null };
}

/**
 * True when a retry has any chance of a different outcome.
 *
 * A hard refusal is a policy decision: re-asking burns the budget and, from
 * Google's side, looks like hammering. Upstream errors and soft refusals are
 * worth a native re-ask because Gemini rebuilds the payload itself.
 */
export function isRetryWorthwhile(kind) {
  return kind === REFUSAL_KIND.UPSTREAM_ERROR || kind === REFUSAL_KIND.SOFT_REFUSAL;
}

/**
 * Backoff schedule for native re-asks, in milliseconds.
 * 3 attempts: 2s -> 5s -> 12s (cumulative ~19s). Beyond three, hammering the
 * UI risks Google's rate limiter for no measured benefit.
 */
export const RETRY_BACKOFF_MS = [2000, 5000, 12000];
