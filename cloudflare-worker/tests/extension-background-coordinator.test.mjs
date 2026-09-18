import test from 'node:test';
import assert from 'node:assert/strict';
import { CentralTabCoordinator } from '../../extension-cloudflare/background.js';

class MockPort {
  constructor(name, tabId) {
    this.name = name;
    this.sender = { tab: { id: tabId } };
    this.messages = [];
    this.messageListeners = [];
    this.disconnectListeners = [];
    this.onMessage = {
      addListener: (fn) => this.messageListeners.push(fn)
    };
    this.onDisconnect = {
      addListener: (fn) => this.disconnectListeners.push(fn)
    };
  }

  postMessage(msg) {
    this.messages.push(msg);
  }

  simulateClientMessage(msg) {
    for (const fn of this.messageListeners) fn(msg);
  }

  simulateDisconnect() {
    for (const fn of this.disconnectListeners) fn();
  }
}

function createMockSessionStorage() {
  const store = {};
  return {
    store,
    get: (keys, cb) => {
      const res = {};
      for (const k of keys) res[k] = store[k];
      cb(res);
    },
    set: (obj, cb) => {
      Object.assign(store, obj);
      cb?.();
    },
    remove: (keys, cb) => {
      for (const k of keys) delete store[k];
      cb?.();
    }
  };
}

test('simultaneous startup: first tab is elected leader, concurrent tabs assigned standby', async () => {
  const storage = createMockSessionStorage();
  const coordinator = new CentralTabCoordinator(storage);
  await coordinator.init();

  const tab1Port = new MockPort('gemini-tab-coordinator', 101);
  const tab2Port = new MockPort('gemini-tab-coordinator', 102);
  const tab3Port = new MockPort('gemini-tab-coordinator', 103);

  // Simultaneous connection
  coordinator.handlePortConnect(tab1Port);
  coordinator.handlePortConnect(tab2Port);
  coordinator.handlePortConnect(tab3Port);

  // Tab 1 must be leader
  assert.equal(tab1Port.messages.length, 1);
  assert.deepEqual(tab1Port.messages[0], { type: 'COORDINATOR_STATE', role: 'leader', tabId: 101 });
  assert.equal(coordinator.activeLeaderTabId, 101);
  assert.equal(storage.store.activeLeaderTabId, 101);

  // Tabs 2 and 3 must be standby
  assert.equal(tab2Port.messages.length, 1);
  assert.deepEqual(tab2Port.messages[0], { type: 'COORDINATOR_STATE', role: 'standby', tabId: 102, leaderTabId: 101 });

  assert.equal(tab3Port.messages.length, 1);
  assert.deepEqual(tab3Port.messages[0], { type: 'COORDINATOR_STATE', role: 'standby', tabId: 103, leaderTabId: 101 });
});

test('failover: leader port disconnect immediately promotes next available tab to leader', async () => {
  const storage = createMockSessionStorage();
  const coordinator = new CentralTabCoordinator(storage);
  await coordinator.init();

  const tab1Port = new MockPort('gemini-tab-coordinator', 101);
  const tab2Port = new MockPort('gemini-tab-coordinator', 102);

  coordinator.handlePortConnect(tab1Port);
  coordinator.handlePortConnect(tab2Port);

  assert.equal(coordinator.activeLeaderTabId, 101);

  // Leader tab closes / disconnects
  tab1Port.simulateDisconnect();

  // Tab 2 should have received a new leader notification
  assert.equal(coordinator.activeLeaderTabId, 102);
  assert.equal(storage.store.activeLeaderTabId, 102);
  const lastTab2Msg = tab2Port.messages.at(-1);
  assert.deepEqual(lastTab2Msg, { type: 'COORDINATOR_STATE', role: 'leader', tabId: 102 });
});

test('user manual takeover: standby tab claiming leadership demotes old leader and promotes new leader', async () => {
  const storage = createMockSessionStorage();
  const coordinator = new CentralTabCoordinator(storage);
  await coordinator.init();

  const tab1Port = new MockPort('gemini-tab-coordinator', 101);
  const tab2Port = new MockPort('gemini-tab-coordinator', 102);

  coordinator.handlePortConnect(tab1Port);
  coordinator.handlePortConnect(tab2Port);

  assert.equal(coordinator.activeLeaderTabId, 101);

  // User clicks on Tab 2: sends CLAIM_LEADERSHIP
  tab2Port.simulateClientMessage({ type: 'CLAIM_LEADERSHIP' });

  // Tab 1 must receive demotion to standby
  const lastTab1Msg = tab1Port.messages.at(-1);
  assert.deepEqual(lastTab1Msg, { type: 'COORDINATOR_STATE', role: 'standby', tabId: 101, leaderTabId: 102 });

  // Tab 2 must receive promotion to leader
  const lastTab2Msg = tab2Port.messages.at(-1);
  assert.deepEqual(lastTab2Msg, { type: 'COORDINATOR_STATE', role: 'leader', tabId: 102 });
  assert.equal(coordinator.activeLeaderTabId, 102);
});

test('service worker restart recovery: re-reads persisted leader from session storage', async () => {
  const storage = createMockSessionStorage();
  storage.store.activeLeaderTabId = 205; // Persisted from before service worker idle/restart

  const restartedCoordinator = new CentralTabCoordinator(storage);
  await restartedCoordinator.init();

  assert.equal(restartedCoordinator.activeLeaderTabId, 205);

  // When tab 205 reconnects, it is recognized as current leader
  const tab205Port = new MockPort('gemini-tab-coordinator', 205);
  restartedCoordinator.handlePortConnect(tab205Port);

  assert.equal(tab205Port.messages.length, 1);
  assert.deepEqual(tab205Port.messages[0], { type: 'COORDINATOR_STATE', role: 'leader', tabId: 205 });
});
