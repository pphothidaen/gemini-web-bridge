// ============================================================
// Gemini Web-Bridge: Dedicated-Tab Coordinator
// Single designated bridge tab coordinator; other tabs don't steal socket
// ============================================================

(function (root) {
  "use strict";

  const STORAGE_KEY = "gemini_active_bridge_tab";
  const BROADCAST_CHANNEL = "gemini_bridge_coordinator";
  const LEASE_DURATION = 6000;
  const HEARTBEAT_INTERVAL = 2000;

  class TabCoordinator {
    constructor(options = {}) {
      this.tabId = options.tabId || `tab_${Math.random().toString(36).substring(2, 10)}_${Date.now()}`;
      this.storage = options.storage || (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? chrome.storage.local : null);
      this.onBecomeLeader = options.onBecomeLeader || (() => {});
      this.onBecomeStandby = options.onBecomeStandby || (() => {});
      
      this.isLeader = false;
      this.heartbeatTimer = null;
      this.channel = null;

      if (typeof BroadcastChannel !== "undefined") {
        try {
          this.channel = new BroadcastChannel(BROADCAST_CHANNEL);
          this.channel.onmessage = (event) => this.handleBroadcastMessage(event.data);
        } catch (e) {
          // BroadcastChannel unavailable in some environments
        }
      }

      // Bind unload handlers to yield coordinator role immediately
      if (typeof window !== "undefined") {
        this._unloadHandler = () => this.yieldLeadership();
        window.addEventListener("beforeunload", this._unloadHandler);
        window.addEventListener("pagehide", this._unloadHandler);
      }
    }

    /**
     * Starts coordinator election and heartbeat loop.
     */
    async start() {
      await this.evaluateElection();
      this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL);
    }

    /**
     * Evaluates current election state against storage / lease.
     */
    async evaluateElection() {
      const lease = await this.readLease();
      const now = Date.now();

      if (!lease || !lease.tabId || now > lease.expiresAt) {
        // No active lease or lease has expired: claim leadership
        await this.claimLeadership();
      } else if (lease.tabId === this.tabId) {
        // Renew our leadership
        await this.renewLease();
      } else {
        // Another tab is active leader: become standby
        this.stepDown();
      }
    }

    /**
     * Heartbeat loop: renew lease if leader, or detect expired leader if standby.
     */
    async heartbeat() {
      if (this.isLeader) {
        await this.renewLease();
      } else {
        const lease = await this.readLease();
        const now = Date.now();
        if (!lease || !lease.tabId || now > lease.expiresAt) {
          console.log("[TabCoordinator] Active lease expired. Claiming leadership for:", this.tabId);
          await this.claimLeadership();
        }
      }
    }

    /**
     * Claims leadership lease in storage and notifies other tabs.
     */
    async claimLeadership(force = false) {
      const now = Date.now();
      const lease = {
        tabId: this.tabId,
        timestamp: now,
        expiresAt: now + LEASE_DURATION
      };

      await this.writeLease(lease);

      if (!this.isLeader) {
        this.isLeader = true;
        this.broadcast({ type: force ? "FORCE_CLAIM" : "CLAIM", tabId: this.tabId, expiresAt: lease.expiresAt });
        this.onBecomeLeader();
      }
    }

    /**
     * Renews the leadership lease if we are still the active leader.
     */
    async renewLease() {
      const now = Date.now();
      const lease = {
        tabId: this.tabId,
        timestamp: now,
        expiresAt: now + LEASE_DURATION
      };

      await this.writeLease(lease);
      this.broadcast({ type: "HEARTBEAT", tabId: this.tabId, expiresAt: lease.expiresAt });
    }

    /**
     * Steps down to standby mode (another tab is leader).
     */
    stepDown() {
      if (this.isLeader) {
        this.isLeader = false;
        this.onBecomeStandby();
      }
    }

    /**
     * Yields leadership explicitly on tab close or manual step-down.
     */
    async yieldLeadership() {
      if (!this.isLeader) return;
      this.isLeader = false;
      this.broadcast({ type: "YIELD", tabId: this.tabId });
      await this.clearLease();
      this.onBecomeStandby();
    }

    /**
     * Handles broadcast messages between Gemini tabs.
     */
    handleBroadcastMessage(msg) {
      if (!msg || msg.tabId === this.tabId) return;

      if (msg.type === "FORCE_CLAIM" || msg.type === "CLAIM") {
        // Another tab claimed leadership
        if (this.isLeader) {
          console.log("[TabCoordinator] Another tab claimed leadership. Stepping down to standby.");
          this.stepDown();
        }
      } else if (msg.type === "YIELD") {
        // Previous leader tab closed or stepped down: immediately claim leadership
        this.claimLeadership();
      }
    }

    broadcast(msg) {
      if (this.channel) {
        try {
          this.channel.postMessage(msg);
        } catch (e) {
          // Channel closed or failed
        }
      }
    }

    readLease() {
      return new Promise((resolve) => {
        if (!this.storage) return resolve(null);
        try {
          this.storage.get([STORAGE_KEY], (res) => resolve(res?.[STORAGE_KEY] || null));
        } catch (e) {
          resolve(null);
        }
      });
    }

    writeLease(lease) {
      return new Promise((resolve) => {
        if (!this.storage) return resolve();
        try {
          this.storage.set({ [STORAGE_KEY]: lease }, () => resolve());
        } catch (e) {
          resolve();
        }
      });
    }

    clearLease() {
      return new Promise((resolve) => {
        if (!this.storage) return resolve();
        try {
          this.storage.remove([STORAGE_KEY], () => resolve());
        } catch (e) {
          resolve();
        }
      });
    }

    destroy() {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (this.channel) {
        try { this.channel.close(); } catch (e) {}
        this.channel = null;
      }
      if (typeof window !== "undefined" && this._unloadHandler) {
        window.removeEventListener("beforeunload", this._unloadHandler);
        window.removeEventListener("pagehide", this._unloadHandler);
      }
    }
  }

  root.TabCoordinator = TabCoordinator;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { TabCoordinator };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
