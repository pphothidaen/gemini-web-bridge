// ============================================================
// Gemini Web-Bridge: Background Service Worker Coordinator
// Centralized dedicated-tab coordinator for Chrome Extension
// ============================================================

export class CentralTabCoordinator {
  constructor(storageSession = null) {
    this.sessionStorage = storageSession || (typeof chrome !== "undefined" && chrome.storage?.session ? chrome.storage.session : null);
    this.connectedPorts = new Map(); // tabId -> Port
    this.activeLeaderTabId = null;
    this.initialized = false;
  }

  async init() {
    if (this.sessionStorage) {
      try {
        const stored = await new Promise((resolve) => {
          this.sessionStorage.get(["activeLeaderTabId"], (res) => resolve(res || {}));
        });
        if (stored?.activeLeaderTabId) {
          this.activeLeaderTabId = stored.activeLeaderTabId;
        }
      } catch (e) {
        console.warn("[BackgroundCoordinator] Error reading session storage:", e);
      }
    }
    this.initialized = true;
  }

  handlePortConnect(port) {
    if (port.name !== "gemini-tab-coordinator") return;

    const tabId = port.sender?.tab?.id ?? (port._mockTabId || Math.floor(Math.random() * 1000000));
    this.connectedPorts.set(tabId, port);

    // Election logic
    if (this.activeLeaderTabId === null || !this.connectedPorts.has(this.activeLeaderTabId)) {
      this.activeLeaderTabId = tabId;
      this.persistLeader(tabId);
      this.sendPortMessage(port, { type: "COORDINATOR_STATE", role: "leader", tabId });
      console.log(`[BackgroundCoordinator] 👑 Tab ${tabId} elected as Leader`);
    } else if (this.activeLeaderTabId === tabId) {
      // Reconnecting leader tab
      this.sendPortMessage(port, { type: "COORDINATOR_STATE", role: "leader", tabId });
    } else {
      // Existing active leader exists: assign standby
      this.sendPortMessage(port, { type: "COORDINATOR_STATE", role: "standby", tabId, leaderTabId: this.activeLeaderTabId });
      console.log(`[BackgroundCoordinator] 💤 Tab ${tabId} assigned as Standby (Leader is ${this.activeLeaderTabId})`);
    }

    port.onMessage.addListener((msg) => {
      if (msg?.type === "CLAIM_LEADERSHIP") {
        this.promoteToLeader(tabId);
      }
    });

    port.onDisconnect.addListener(() => {
      this.connectedPorts.delete(tabId);
      console.log(`[BackgroundCoordinator] Tab ${tabId} disconnected`);

      if (this.activeLeaderTabId === tabId) {
        this.activeLeaderTabId = null;
        // Elect next available connected tab
        const nextEntry = this.connectedPorts.entries().next().value;
        if (nextEntry) {
          const [nextTabId, nextPort] = nextEntry;
          this.activeLeaderTabId = nextTabId;
          this.persistLeader(nextTabId);
          this.sendPortMessage(nextPort, { type: "COORDINATOR_STATE", role: "leader", tabId: nextTabId });
          console.log(`[BackgroundCoordinator] 👑 Failover: Tab ${nextTabId} promoted to Leader`);
        } else {
          this.clearLeader();
        }
      }
    });
  }

  promoteToLeader(tabId) {
    if (this.activeLeaderTabId === tabId) return;

    const oldLeaderId = this.activeLeaderTabId;
    this.activeLeaderTabId = tabId;
    this.persistLeader(tabId);

    // Demote previous leader if connected
    if (oldLeaderId !== null && this.connectedPorts.has(oldLeaderId)) {
      const oldPort = this.connectedPorts.get(oldLeaderId);
      this.sendPortMessage(oldPort, { type: "COORDINATOR_STATE", role: "standby", tabId: oldLeaderId, leaderTabId: tabId });
    }

    // Promote new leader
    if (this.connectedPorts.has(tabId)) {
      const newPort = this.connectedPorts.get(tabId);
      this.sendPortMessage(newPort, { type: "COORDINATOR_STATE", role: "leader", tabId });
    }

    console.log(`[BackgroundCoordinator] 👑 User takeover: Tab ${tabId} promoted to Leader`);
  }

  sendPortMessage(port, msg) {
    try {
      port.postMessage(msg);
    } catch (e) {
      console.warn("[BackgroundCoordinator] Error posting port message:", e);
    }
  }

  persistLeader(tabId) {
    if (this.sessionStorage) {
      try {
        this.sessionStorage.set({ activeLeaderTabId: tabId });
      } catch (e) {}
    }
  }

  clearLeader() {
    if (this.sessionStorage) {
      try {
        this.sessionStorage.remove(["activeLeaderTabId"]);
      } catch (e) {}
    }
  }
}

// Instantiate singleton for browser extension runtime
if (typeof chrome !== "undefined" && chrome.runtime?.onConnect) {
  const coordinator = new CentralTabCoordinator();
  coordinator.init().then(() => {
    chrome.runtime.onConnect.addListener((port) => coordinator.handlePortConnect(port));
  });
}
