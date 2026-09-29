// ============================================================
// Gemini Web-Bridge: Notebook attachment
// Attach a NotebookLM notebook to the live conversation at its
// real /app/ URL, instead of navigating away to /notebook/<id>.
//
// Why this exists
// ---------------
// `horo_consult` needs answers grounded in the HoroConsultant
// notebook. Navigating the tab to gemini.google.com/notebook/<id>
// looks like the obvious approach, but the notebook page is not a
// chat surface: asking there wraps the question in a "คุณบอกว่า…"
// preamble and spawns a NEW conversation under /app/<new-id>, so the
// bridge loses the scope it asked for and never sees the answer in
// the element it is watching.
//
// Gemini's own UI already does the right thing. The "+" button opens
//  > "การอัปโหลดเพิ่มเติม"  (button.more-upload-button)
//    > "Notebooks"         ([data-test-id="notebooks-import-button"])
//      > dialog "เพิ่ม Notebook", pick a row, press "เพิ่ม"
// and the notebook becomes an attachment chip on the conversation
// already open. That keeps the URL, the conversation, and the scope
// the bridge resolved, and it is the same control a human uses.
//
// Selectors — every one verified against the live DOM
// ---------------------------------------------------
// Verified 2026-09-29 on boq-gemini-web-uiserver, via Kapture against
// an authenticated gemini.google.com tab. A selector copied from a
// DOM sample is a hypothesis, not a fact, so each one below was
// exercised in a real browser and the resulting DOM re-read.
//
// NOT localization-safe, and deliberately not used as a primary key:
//   - "การอัปโหลดเพิ่มเติม" / "Notebooks" / "เพิ่ม Notebook" / "เพิ่ม"
//   - aria-label="อัปโหลดและเครื่องมือ" (the "+" button)
// The UI ships in Thai here and English elsewhere; every selector
// below is a test-id, a class, or an icon name instead. The row is
// matched by NAME, never by list position — the account has six
// notebooks and the target is not always first.
//
//   1. + button      input-area-v2 mat-icon[data-mat-icon-name="plus"]
//   2. menu pane     .cdk-overlay-pane        (detached CDK overlay)
//   3. more uploads  button.more-upload-button[cdkoverlayorigin]
//   4. Notebooks     [data-test-id="notebooks-import-button"]
//   5. dialog        mat-dialog-container
//   6. row           [data-test-id="notebook-item-title"] -> mat-list-option
//   7. confirm       [data-test-id="add-button"]  (disabled until a row)
//   8. success       input-area-v2 uploader-file-preview  ("Horo" chip)
// ============================================================

(function (root) {
  "use strict";

  // Every selector used to drive the attach flow, named for logging.
  // A flow that silently does nothing is the failure mode this module
  // exists to prevent, so each step reports which selector it used.
  const SELECTORS = {
    plusButton: 'input-area-v2 mat-icon[data-mat-icon-name="plus"]',
    overlayPane: ".cdk-overlay-pane",
    moreUploadsButton: "button.more-upload-button[cdkoverlayorigin]",
    notebooksButton: '[data-test-id="notebooks-import-button"]',
    dialog: "mat-dialog-container",
    notebookTitle: '[data-test-id="notebook-item-title"]',
    addButton: '[data-test-id="add-button"]',
    cancelButton: '[data-test-id="cancel-button"]',
    attachedChip: "input-area-v2 uploader-file-preview"
  };

  const STEP_TIMEOUT_MS = 6000;
  const POLL_MS = 150;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * True when the tab is foregrounded.
   *
   * Not a nicety — it is a correctness requirement, found the hard way.
   * A CDK overlay pane is created in the DOM and the trigger flips to
   * aria-expanded="true" even while the tab is HIDDEN, but Angular
   * never populates the panel: `.cdk-overlay-pane` exists and is
   * empty, so every child selector downstream matches nothing. The flow
   * then fails at "more_uploads" for what looks like a selector bug.
   *
   * The bridge must therefore focus the tab before attaching, or this
   * returns a distinct, honest error rather than a misleading one.
   *
   * @param {Document} doc
   * @returns {boolean}
   */
  function isTabVisible(doc = document) {
    if (typeof doc.hidden === "boolean") return !doc.hidden;
    // Documents without the Page Visibility API (jsdom, some test rigs)
    // are treated as visible: absence of evidence is not evidence of a
    // hidden tab, and failing closed here would break every test.
    return true;
  }

  /**
   * Poll until `predicate` returns a truthy value, or give up.
   *
   * Polling rather than MutationObserver on purpose: the nodes we wait
   * for live in a detached CDK overlay and an Angular Material dialog,
   * both of which are created and torn down wholesale. A stable poll is
   * easier to reason about than a subtree observer that has to be
   * attached to a container which does not exist yet.
   *
   * @param {Function} predicate
   * @param {number} timeoutMs
   * @param {Document} doc  injected so tests need no global `document`
   * @param {Function} now
   * @param {Function} setT
   * @returns {Promise<*>} the truthy value, or null on timeout
   */
  function waitFor(predicate, timeoutMs, doc, now, setT) {
    return new Promise((resolve) => {
      const startedAt = now();
      const poll = () => {
        let value = null;
        try {
          value = predicate(doc);
        } catch (e) {
          value = null;
        }
        if (value) {
          resolve(value);
          return;
        }
        if (now() - startedAt >= timeoutMs) {
          resolve(null);
          return;
        }
        setT(poll, POLL_MS);
      };
      poll();
    });
  }

  /**
   * The "+" button that opens the upload-and-tools menu.
   *
   * Keyed on the Material icon name, not the button's aria-label: the
   * label is localized ("อัปโหลดและเครื่องมือ" here) and the icon name
   * is not.
   */
  function findPlusButton(doc = document) {
    const icon = doc.querySelector(SELECTORS.plusButton);
    if (!icon) return null;
    return icon.closest("button") || icon;
  }

  /**
   * Open the "+" menu, but only if it is closed.
   *
   * The trigger is a toggle: clicking an already-open menu CLOSES it.
   * A blind click therefore breaks any retry that follows a partially
   * completed attempt, and the failure surfaces much later as a missing
   * menu item. Checking aria-expanded makes the step idempotent.
   *
   * @returns {boolean} whether a click was issued
   */
  function openPlusMenu(doc = document) {
    const plus = findPlusButton(doc);
    if (!plus) return false;
    if (plus.getAttribute && plus.getAttribute("aria-expanded") === "true") {
      return false; // already open — clicking would close it
    }
    plus.click();
    return true;
  }

  /**
   * The "more uploads" submenu host in the open "+" menu.
   *
   * Matched by class, not by its label. "more_horiz" is shared with the
   * "เครื่องมือเพิ่มเติม" item, so icon and text matching cannot
   * discriminate; the class can.
   */
  function findMoreUploadsButton(doc = document) {
    return doc.querySelector(SELECTORS.moreUploadsButton);
  }

  /** The "Notebooks" entry inside the more-uploads submenu. */
  function findNotebooksButton(doc = document) {
    return doc.querySelector(SELECTORS.notebooksButton);
  }

  /**
   * The row for one notebook in the "เพิ่ม Notebook" dialog.
   *
   * Matched by NAME because the dialog exposes no notebook id — the id
   * only exists on the sidenav link, in a different surface. The name
   * is the caller's own input (a constant in the worker), so this is
   * not a comparison against a localized UI string; the labels around
   * it are.
   *
   * @param {string} notebookName  e.g. "Horo"
   * @returns {Element|null} the mat-list-option, which is the clickable row
   */
  function findNotebookRow(doc, notebookName) {
    const wanted = String(notebookName || "").trim().toLowerCase();
    if (!wanted) return null;
    const titles = doc.querySelectorAll(SELECTORS.notebookTitle);
    for (const t of titles) {
      if ((t.textContent || "").trim().toLowerCase() === wanted) {
        return t.closest("mat-list-option") || t.closest(".notebook-item-container") || t;
      }
    }
    return null;
  }

  /**
   * Names of the notebooks currently attached to this conversation.
   *
   * Doubles as the idempotency check: if the target notebook is already
   * a chip in the input area, attaching it again would either duplicate
   * the grounding or do nothing while still costing a round trip.
   *
   * @returns {string[]}
   */
  function readAttachedNotebooks(doc = document) {
    const chips = doc.querySelectorAll(SELECTORS.attachedChip);
    return Array.from(chips)
      .map((c) => (c.innerText || c.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  /** True when `notebookName` is already attached to this conversation. */
  function isNotebookAttached(notebookName, doc = document) {
    const wanted = String(notebookName || "").trim().toLowerCase();
    if (!wanted) return false;
    return readAttachedNotebooks(doc).some((n) => n.toLowerCase() === wanted);
  }

  /** Close the attach dialog if one is open, so a retry starts clean. */
  function dismissDialog(doc = document) {
    const dialog = doc.querySelector(SELECTORS.dialog);
    if (!dialog) return false;
    const cancel = dialog.querySelector(SELECTORS.cancelButton);
    if (cancel) {
      cancel.click();
      return true;
    }
    return false;
  }

  /**
   * Attach a notebook to the current conversation.
   *
   * @param {object} opts
   * @param {string} opts.notebookName      e.g. "Horo"
   * @param {number} [opts.timeoutMs]       per-step budget
   * @param {Document} [opts.doc]           injected for tests
   * @param {Function} [opts.now]
   * @param {Function} [opts.setT]
   * @param {Function} [opts.sleep]
   * @param {Function} [opts.log]           receives progress lines
   * @returns {Promise<{ok: boolean, reason?: string, step?: string,
   *                    attached?: string[], alreadyAttached?: boolean}>}
   */
  async function attachNotebook(opts = {}) {
    const {
      notebookName,
      timeoutMs = STEP_TIMEOUT_MS,
      doc = document,
      now = Date.now,
      setT = setTimeout,
      sleep: sleepFn = sleep,
      log = () => {}
    } = opts;

    const name = String(notebookName || "").trim();
    if (!name) {
      return { ok: false, reason: "no_notebook_name", step: "validate" };
    }

    // Idempotency: the whole flow is a UI round trip, so skip it when
    // the notebook is already on the conversation.
    if (isNotebookAttached(name, doc)) {
      log(`notebook "${name}" already attached; skipping`);
      return {
        ok: true,
        alreadyAttached: true,
        attached: readAttachedNotebooks(doc)
      };
    }

    // A dialog left open by a previous attempt would swallow the next
    // one. Clear it before starting.
    if (dismissDialog(doc)) {
      await sleepFn(400);
    }

    // Checked BEFORE the first click. A hidden tab opens an empty menu,
    // which then fails several steps later with a selector-shaped error
    // that has nothing to do with the selector.
    if (!isTabVisible(doc)) {
      log("[attach] step=visibility FAILED tab is not foregrounded");
      return { ok: false, reason: "tab_not_visible", step: "visibility" };
    }

    // Step 1 — open the "+" menu. Idempotent: an already-open menu is
    // left alone, since the trigger toggles.
    if (!findPlusButton(doc)) {
      log(`[attach] step=open_plus FAILED selector="${SELECTORS.plusButton}"`);
      return { ok: false, reason: "plus_button_not_found", step: "open_plus" };
    }
    const opened = openPlusMenu(doc);
    log(`[attach] step=open_plus ok selector="${SELECTORS.plusButton}" (clicked=${opened})`);

    const pane = await waitFor(
      (d) => d.querySelector(SELECTORS.overlayPane),
      timeoutMs, doc, now, setT
    );
    if (!pane) {
      log(`[attach] step=await_pane FAILED selector="${SELECTORS.overlayPane}"`);
      return { ok: false, reason: "menu_pane_timeout", step: "await_pane" };
    }

    // Step 2 — open the "more uploads" submenu.
    const moreUploads = await waitFor(
      (d) => findMoreUploadsButton(d),
      timeoutMs, doc, now, setT
    );
    if (!moreUploads) {
      log(`[attach] step=more_uploads FAILED selector="${SELECTORS.moreUploadsButton}"`);
      return { ok: false, reason: "more_uploads_not_found", step: "more_uploads" };
    }
    moreUploads.click();
    log(`[attach] step=more_uploads ok selector="${SELECTORS.moreUploadsButton}"`);

    // Step 3 — the submenu pane is a NEW overlay, so the Notebooks entry
    // is only queryable once it exists.
    const notebooksButton = await waitFor(
      (d) => findNotebooksButton(d),
      timeoutMs, doc, now, setT
    );
    if (!notebooksButton) {
      log(`[attach] step=notebooks FAILED selector="${SELECTORS.notebooksButton}"`);
      return { ok: false, reason: "notebooks_entry_not_found", step: "notebooks" };
    }
    notebooksButton.click();
    log(`[attach] step=notebooks ok selector="${SELECTORS.notebooksButton}"`);

    // Step 4 — the "เพิ่ม Notebook" dialog.
    const dialog = await waitFor(
      (d) => d.querySelector(SELECTORS.dialog),
      timeoutMs, doc, now, setT
    );
    if (!dialog) {
      log(`[attach] step=dialog FAILED selector="${SELECTORS.dialog}"`);
      return { ok: false, reason: "dialog_timeout", step: "dialog" };
    }
    log(`[attach] step=dialog ok selector="${SELECTORS.dialog}"`);

    // Step 5 — select the target row. Selection is what enables the
    // confirm button, so a missing row is a distinct failure from a
    // disabled one and is reported as such.
    const row = await waitFor(
      (d) => findNotebookRow(d, name),
      timeoutMs, doc, now, setT
    );
    if (!row) {
      const available = Array.from(dialog.querySelectorAll(SELECTORS.notebookTitle))
        .map((t) => (t.textContent || "").trim())
        .filter(Boolean);
      log(`[attach] step=select_row FAILED wanted="${name}" available=${JSON.stringify(available)}`);
      dismissDialog(doc);
      return {
        ok: false,
        reason: "notebook_row_not_found",
        step: "select_row",
        available
      };
    }
    row.click();
    log(`[attach] step=select_row ok notebook="${name}" selector="${SELECTORS.notebookTitle}"`);

    // Step 6 — confirm. The button is disabled until a row is selected,
    // so wait for it to become enabled rather than assuming the click
    // landed: a disabled click is a silent no-op that would otherwise
    // look like a successful attach.
    const addButton = await waitFor(
      (d) => {
        const b = d.querySelector(SELECTORS.addButton);
        if (!b) return null;
        return b.hasAttribute("disabled") || b.getAttribute("aria-disabled") === "true"
          ? null
          : b;
      },
      timeoutMs, doc, now, setT
    );
    if (!addButton) {
      log(`[attach] step=confirm FAILED selector="${SELECTORS.addButton}" (never enabled)`);
      dismissDialog(doc);
      return { ok: false, reason: "confirm_button_stuck_disabled", step: "confirm" };
    }
    addButton.click();
    log(`[attach] step=confirm ok selector="${SELECTORS.addButton}"`);

    // Step 7 — the attach is only real once the chip is in the input
    // area. Clicking the button and returning success would be a guess.
    const chip = await waitFor(
      (d) => (isNotebookAttached(name, d) ? d.querySelector(SELECTORS.attachedChip) : null),
      timeoutMs, doc, now, setT
    );
    if (!chip) {
      log(`[attach] step=verify FAILED selector="${SELECTORS.attachedChip}"`);
      return { ok: false, reason: "attach_not_observed", step: "verify" };
    }
    log(`[attach] step=verify ok selector="${SELECTORS.attachedChip}"`);

    return { ok: true, attached: readAttachedNotebooks(doc) };
  }

  /**
   * Detach a notebook, so a conversation can be returned to a clean
   * state before it is used for a non-notebook tool.
   *
   * @param {object} opts
   * @param {string} opts.notebookName
   * @param {Document} [opts.doc]
   * @returns {boolean} whether a chip was removed
   */
  function detachNotebook(opts = {}) {
    const { notebookName, doc = document } = opts;
    const name = String(notebookName || "").trim().toLowerCase();
    if (!name) return false;
    const chips = doc.querySelectorAll(SELECTORS.attachedChip);
    for (const chip of chips) {
      const label = (chip.innerText || chip.textContent || "").replace(/\s+/g, " ").trim();
      if (label.toLowerCase() !== name) continue;
      const remove = chip.querySelector("button");
      if (remove) {
        remove.click();
        return true;
      }
    }
    return false;
  }

  const api = {
    SELECTORS,
    findPlusButton,
    openPlusMenu,
    findMoreUploadsButton,
    findNotebooksButton,
    findNotebookRow,
    readAttachedNotebooks,
    isNotebookAttached,
    isTabVisible,
    dismissDialog,
    attachNotebook,
    detachNotebook,
    waitFor
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.NotebookAttach = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

