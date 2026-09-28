// Human-sounding prompt construction for the SDLC tools.
//
// Why prose instead of the old "[Role: ...] / Language: ... / Task: ..." blocks
// -----------------------------------------------------------------------------
// The original templates were field labels — a spec sheet, not something a
// person would type. Two findings drove the rewrite:
//
//  1. "Prompt Design at Scale" (arXiv 2607.19257, which benchmarks Gemini
//     Flash) reports no *reliable* accuracy winner among plain / markdown /
//     prose formats — but its Section 5.5 finds that refusal, not wrong recall,
//     is what actually rises, and that most of the structured-format errors it
//     observed were outright refusals. Gemini rejecting a spec-shaped payload
//     is a documented failure mode, not folklore.
//  2. A live A/B on production (2026-09-28) showed the *replay* path fails
//     identically for "[Role: Expert Code Reviewer & Debugger]" and for
//     "What is the capital of France?", proving the transport payload is the
//     real defect. Prose therefore does not fix the outage — it is here to
//     improve answer quality and keep the prompt something a human would send.
//
// What is deliberately kept: fenced code blocks. Pasting code inside backticks
// is exactly what a developer does in a chat window, and stripping the fence
// would only make the snippet harder for Gemini to delimit.
//
// Every template:
//   • opens with a natural "Act as ..." framing,
//   • states the situation in sentences,
//   • asks for the deliverable as a request, not an imperative label,
//   • echoes the caller's own words instead of relabelling them,
//   • never emits "undefined" for a missing optional field.

/** Strip a code fence if the caller already supplied one. */
function withoutFence(code) {
  return String(code).replace(/^```[a-zA-Z0-9]*\n?/, "").replace(/```$/, "").trimEnd();
}

/**
 * Join sentences with a single space, dropping empties.
 *
 * Whitespace is collapsed per-part, never across the joined result: a global
 * collapse also flattens a fenced code block onto one line, which destroys the
 * very structure Gemini needs to read a snippet correctly.
 */
function sentences(...parts) {
  return parts
    .map((p) => {
      if (typeof p !== "string") return "";
      return p
        // Collapse runs of spaces/tabs, but never the leading indentation of a
        // line: that indentation IS the code snippet's structure, and a global
        // collapse silently reformats the caller's code before Gemini sees it.
        .replace(/[ \t]{2,}/g, (run, offset) => {
          const before = p.slice(0, offset);
          return /(^|\n)[ \t]*$/.test(before) ? run : " ";
        })
        .replace(/[ \t]+\n/g, "\n")
        .trim();
    })
    .filter(Boolean)
    .join(" ");
}

/** A short closing request, shared by every tool. */
const ASK = {
  architect: "Walk me through the architecture you'd recommend, how the pieces fit together, and what I'd need to build it step by step.",
  plan: "Break that down into the tasks I'd work through in order, and tell me what each stage should produce.",
  review: "Can you find the root cause, flag anything that looks unsafe, and give me a clean patch I can drop in?",
  tradeoffs: "I'd like a side-by-side comparison across scalability, performance, developer experience and maintenance, and your recommendation at the end.",
  horo: "Please structure the answer clearly, answer in the same language I asked, and tell me where the reading runs into limits."
};

/**
 * Build the prompt for one tool.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @returns {string}
 */
export function buildToolPrompt(toolName, args = {}) {
  const a = args || {};
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

  if (toolName === "sdlc_solution_architect") {
    const problem = str(a.problem_description) || str(a.feature_or_goal) || str(a.goal) || str(a.description);
    const stack = str(a.tech_stack);
    const constraints = str(a.constraints);
    return sentences(
      "Act as a senior solution architect.",
      problem ? `I'm working out how to solve this: ${problem}` : "",
      stack ? `It has to run on ${stack}.` : "",
      constraints ? `The constraints I have to live with are: ${constraints}.` : "",
      ASK.architect
    );
  }

  if (toolName === "orchestrate_sdlc_plan") {
    const goal = str(a.feature_or_goal) || str(a.problem_description) || str(a.goal) || str(a.description);
    const stage = str(a.current_stage);
    return sentences(
      "Act as an SDLC orchestrator.",
      goal ? `Here's what I'm trying to ship: ${goal}` : "",
      stage ? `Right now we're at the ${stage} stage.` : "Right now we're still in the planning stage.",
      ASK.plan
    );
  }

  if (toolName === "code_review_and_debug") {
    const snippet = str(a.code_snippet) || str(a.problem_description);
    const language = str(a.language);
    const errorLog = str(a.error_log);
    const fenceLang = language && /^[a-zA-Z0-9+#.-]+$/.test(language) ? language : "";
    const body = withoutFence(snippet);
    // Assembled AFTER the sentence join: collapsing whitespace across a fenced
    // block would flatten the snippet onto one line and destroy its structure,
    // which is the one thing Gemini needs it to keep.
    const fenced = "```" + fenceLang + "\n" + body + "\n```";
    return sentences(
      "Act as an expert code reviewer and debugger.",
      language ? `I'm working in ${language} and this isn't doing what I expect:` : "This isn't doing what I expect:",
      errorLog && !/^none$/i.test(errorLog) ? `What I see is: ${errorLog}.` : "",
      "Can you find the root cause, flag anything that looks unsafe, and give me a clean patch I can drop in?",
      fenced
    );
  }

  if (toolName === "evaluate_tech_tradeoffs") {
    const context = str(a.decision_context) || str(a.problem_description);
    const options = str(a.options);
    return sentences(
      "Act as a tech lead weighing a decision.",
      context ? `Here's the situation: ${context}` : "",
      options ? `I'm choosing between ${options}.` : "",
      ASK.tradeoffs
    );
  }

  if (toolName === "horo_consult") {
    const query = str(a.query);
    const birth = a.birth_context && typeof a.birth_context === "object"
      ? Object.entries(a.birth_context)
          .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")
      : "";
    return sentences(
      "Act as ซินแส AI ผู้เชี่ยวชาญโหราศาสตร์จีน (BaZi), numerology และดาราศาสตร์ไทย ตอบโดยอ้างอิงความรู้ใน Notebook ที่ผูกไว้เป็นหลัก",
      birth ? `นี่คือข้อมูลดวงชะตาของฉัน: ${birth}` : "ฉันยังไม่ได้ให้ข้อมูลวันเกิดมาเลย",
      `คำถามของฉันคือ: ${query}`,
      ASK.horo
    );
  }

  throw new Error(`No prompt template for tool '${toolName}'`);
}
