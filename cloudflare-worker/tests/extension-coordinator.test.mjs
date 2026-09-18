import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TabCoordinator } = require('../../extension-cloudflare/tab-coordinator.js');

function createMockStorage() {
  const store = {};
  return {
    store,
    get: (keys, cb) => cb({ [keys[0]]: store[keys[0]] }),
    set: (obj, cb) => { Object.assign(store, obj); cb?.(); },
    remove: (keys, cb) => { delete store[keys[0]]; cb?.(); }
  };
}

class MockBroadcastChannel {
  static channels = new Map();
  constructor(name) {
    this.name = name;
    if (!MockBroadcastChannel.channels.has(name)) {
      MockBroadcastChannel.channels.set(name, new Set());
    }
    MockBroadcastChannel.channels.get(name).add(this);
    this.onmessage = () => {};
  }
  postMessage(msg) {
    for (const c of MockBroadcastChannel.channels.get(this.name)) {
      if (c !== this) c.onmessage?.({ data: msg });
    }
  }
  close() {
    MockBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

globalThis.BroadcastChannel = MockBroadcastChannel;

test('first tab claims leader role; second tab becomes standby', async () => {
  const sharedStorage = createMockStorage();

  let tab1State = null;
  let tab2State = null;

  const tab1 = new TabCoordinator({
    tabId: 'tab_1',
    storage: sharedStorage,
    onBecomeLeader: () => { tab1State = 'leader'; },
    onBecomeStandby: () => { tab1State = 'standby'; }
  });

  const tab2 = new TabCoordinator({
    tabId: 'tab_2',
    storage: sharedStorage,
    onBecomeLeader: () => { tab2State = 'leader'; },
    onBecomeStandby: () => { tab2State = 'standby'; }
  });

  await tab1.start();
  assert.equal(tab1State, 'leader');
  assert.equal(tab1.isLeader, true);

  await tab2.start();
  assert.equal(tab2State, null); // never became leader
  assert.equal(tab2.isLeader, false);

  tab1.destroy();
  tab2.destroy();
});

test('when leader tab yields on close, standby tab promotes to leader', async () => {
  const sharedStorage = createMockStorage();

  let tab1Leader = false;
  let tab2Leader = false;

  const tab1 = new TabCoordinator({
    tabId: 'tab_1',
    storage: sharedStorage,
    onBecomeLeader: () => { tab1Leader = true; },
    onBecomeStandby: () => { tab1Leader = false; }
  });

  const tab2 = new TabCoordinator({
    tabId: 'tab_2',
    storage: sharedStorage,
    onBecomeLeader: () => { tab2Leader = true; },
    onBecomeStandby: () => { tab2Leader = false; }
  });

  await tab1.start();
  await tab2.start();

  assert.equal(tab1Leader, true);
  assert.equal(tab2Leader, false);

  // Tab 1 closes / yields leadership
  await tab1.yieldLeadership();
  assert.equal(tab1Leader, false);

  // Tab 2 should now be promoted to leader via broadcast YIELD message
  assert.equal(tab2Leader, true);
  assert.equal(tab2.isLeader, true);

  tab1.destroy();
  tab2.destroy();
});

test('force claim allows user to switch designated bridge tab manually', async () => {
  const sharedStorage = createMockStorage();

  let tab1Leader = false;
  let tab2Leader = false;

  const tab1 = new TabCoordinator({
    tabId: 'tab_1',
    storage: sharedStorage,
    onBecomeLeader: () => { tab1Leader = true; },
    onBecomeStandby: () => { tab1Leader = false; }
  });

  const tab2 = new TabCoordinator({
    tabId: 'tab_2',
    storage: sharedStorage,
    onBecomeLeader: () => { tab2Leader = true; },
    onBecomeStandby: () => { tab2Leader = false; }
  });

  await tab1.start();
  await tab2.start();

  assert.equal(tab1Leader, true);
  assert.equal(tab2Leader, false);

  // User clicks on Tab 2 to make it the active bridge tab
  await tab2.claimLeadership(true);

  assert.equal(tab2Leader, true);
  assert.equal(tab1Leader, false); // Tab 1 stepped down

  tab1.destroy();
  tab2.destroy();
});

test('expired lease causes standby tab to auto-claim leadership', async () => {
  const sharedStorage = createMockStorage();

  let tab2Leader = false;

  // Simulate stale/dead lease in storage from an orphaned tab
  sharedStorage.store['gemini_active_bridge_tab'] = {
    tabId: 'dead_tab_999',
    timestamp: Date.now() - 10000,
    expiresAt: Date.now() - 4000 // expired 4s ago
  };

  const tab2 = new TabCoordinator({
    tabId: 'tab_2',
    storage: sharedStorage,
    onBecomeLeader: () => { tab2Leader = true; },
    onBecomeStandby: () => { tab2Leader = false; }
  });

  await tab2.start();

  // Should recognize dead lease and claim leadership
  assert.equal(tab2Leader, true);
  assert.equal(tab2.isLeader, true);

  tab2.destroy();
});
