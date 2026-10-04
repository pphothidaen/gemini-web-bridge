# Cloudflare Dashboard: Disable Automatic Git Builds Runbook

> **Context:** Cloudflare Dashboard has an automated Git integration ("Workers Builds: gemini-web-bridge") connected to this repository that repeatedly fails on push to `main`.
>
> **Action Type:** **ONE-TIME human action** performed entirely in the Cloudflare Dashboard UI.
> **Code Changes:** **NONE.** No code changes, no configuration changes, and no `wrangler` edits are required or should be made.

---

## 1. Problem Overview (Why Builds Fail)

The Cloudflare Workers Builds integration triggers on GitHub pushes and attempts to build from the repository root. Every build fails due to three fundamental misalignments:

1. **Missing Root Dependencies:** The repository root has no `package.json` — all worker source code and npm dependencies live under [`cloudflare-worker/`](file:///Users/kimlenglim/Project/gemini-web-bridge/cloudflare-worker).
2. **Missing Doppler Secrets:** Cloudflare's build container does not have access to Doppler service tokens or injected runtime secrets (`BRIDGE_AUTH_TOKEN`, `CLIENT_API_KEY`).
3. **Worker Name Mismatch:** The Cloudflare Dashboard build targets the legacy/obsolete worker name `gemini-web-bridge` (which previously produced doubled subdomains: `gemini-web-bridge.gemini-web-bridge.workers.dev`), whereas production is named `prod` (`prod.gemini-web-bridge.workers.dev`).
4. **Bypasses Governance:** Automatic dashboard builds bypass the required human reviewer gate on the `production` environment enforced in GitHub Actions.

**Sole Authorized Deployment Pathway:**
GitHub Actions [`.github/workflows/cd.yml`](file:///Users/kimlenglim/Project/gemini-web-bridge/.github/workflows/cd.yml) is the **sole authorized deployment pipeline**. It handles dependency installation in `cloudflare-worker/`, resolves production secrets from Doppler (`gemini-web-bridge/prd_worker`), enforces reviewer approval, and executes `npx wrangler deploy` for the `prod` worker.

---

## 2. Step-by-Step Resolution in Cloudflare Dashboard

Follow these steps to permanently disable or disconnect automatic Git builds:

### Step 1: Log in to Cloudflare Dashboard
1. Open the [Cloudflare Dashboard](https://dash.cloudflare.com).
2. Ensure you are in the account owning the bridge worker:
   - Account: **`Gemini.web.bridge@gmail.com`**
   - Account ID: `d91b1a43a188b73be61833adee445111`

### Step 2: Navigate to Worker Settings
1. In the left navigation menu, click **Workers & Pages** (or **Compute (Workers) > Workers & Pages**).
2. In the list of Workers, click on **`gemini-web-bridge`** (the worker target where automatic builds are failing).
3. Select the **Settings** tab near the top of the worker overview page.

### Step 3: Access Builds / Git Integration
1. In the Settings sub-menu (left panel or tabs), click **Builds** (or **Builds & deployments** / **Builds & Git** / **Git integration**).

### Step 4: Disconnect or Disable Automatic Builds
Perform either of the following (Option A is recommended):

#### Option A (Recommended): Disconnect Git Repository
1. In the **Git integration** / **Connected repository** section, locate the connected GitHub repository (`pphothidaen/gemini-web-bridge`).
2. Click **Manage repository** or **Disconnect**.
3. Select **Disconnect Git** (or **Disconnect repository**) and confirm when prompted.
   - *Result:* Cloudflare stops listening to GitHub push webhooks for this worker entirely.

#### Option B: Disable Automatic Builds (Pause Builds)
1. If you prefer to keep the repository link metadata intact:
2. Find the **Automatic builds** (or **Build triggers** / **Build on push**) section.
3. Toggle **Automatic builds** to **Disabled** (or pause automatic builds on `main`).
4. Save the configuration.
   - *Result:* Cloudflare will no longer trigger build jobs when commits are pushed to `main`.

---

## 3. Verification

1. **In Cloudflare Dashboard:**
   - Under **Workers & Pages → gemini-web-bridge → Deployments / Builds**, verify no new builds trigger or queued builds show as paused/inactive.
2. **In GitHub:**
   - Push a test commit or inspect the latest commit on `main`.
   - Confirm that GitHub does not receive failing commit status checks from "Cloudflare Workers Builds".
3. **Verify CD Remains Healthy:**
   - Future deployments must proceed strictly via GitHub Actions:
     ```bash
     gh run list --workflow "CD — Deploy & Secret Sync"
     ```
   - Normal CD workflow continues to execute via `.github/workflows/cd.yml` with the production gate.
