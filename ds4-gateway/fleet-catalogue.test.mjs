import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogue, catalogueEntry, CATALOGUE_RANK } from './ui/fleet-catalogue.js';

const member = id => ({ id, machine: id.includes('m3') ? ['m3-ultra'] : [id.includes('sparks12') ? 'spark1' : 'spark3'], scripts: ['status', 'start', 'stop'] });
const worker = (id, over = {}) => ({ id, is_healthy: true, drained: false, quarantine: false, load: 0, queued: 0, ...over });
const device = (id, over = {}) => ({ id, endpoint_metrics: { connected: true, running: 0, at: 1000 }, hardware: { state: 'connected' }, ...over });
const NOW = 5000;

test('catalogue: serving pair and active-first ordering', () => {
  const { entries } = buildCatalogue({
    members: [member('glm53f-sparks34'), member('glm53f-sparks12'), member('mimo-m3')],
    workers: [worker('glm53f-sparks12', { load: 2 }), worker('glm53f-sparks34', { load: 1 })],
    devices: [device('glm53f-sparks12'), device('glm53f-sparks34')],
    routes: { 'GLM-5.3-Flash-EXL3': ['glm53f-sparks12', 'glm53f-sparks34'] },
    now: NOW
  });
  assert.equal(entries[0].state, 'serving-llm');
  assert.deepEqual(entries[0].machines, ['spark1']);
  assert.deepEqual(entries[0].routes, ['GLM-5.3-Flash-EXL3']);
  assert.match(entries[0].detail, /2 active/);
  assert.ok(CATALOGUE_RANK[entries[0].state] < CATALOGUE_RANK[entries[2].state]);
  assert.equal(entries[2].state, 'configured-stopped');
  assert.equal(entries[2].gateway_worker, false);
});

test('catalogue: offline endpoint with machine reachable is engine-stopped, not machine-down; without telemetry it is unknown', () => {
  const down = { ...device('glm53f-m3'), endpoint_metrics: { connected: false, running: 0, at: 1000 } };
  const a = catalogueEntry({ member: member('glm53f-m3'), worker: worker('glm53f-m3', { is_healthy: false }), device: down, mediaBusy: false, now: NOW });
  assert.equal(a.state, 'engine-stopped');
  assert.match(a.detail, /machine reachable/);
  const b = catalogueEntry({ member: member('glm53f-m3'), worker: worker('glm53f-m3', { is_healthy: false }), device: { ...down, hardware: { state: 'disconnected' } }, mediaBusy: false, now: NOW });
  assert.equal(b.state, 'unknown');
  assert.match(b.detail, /does not prove the machine is down/);
});

test('catalogue: drained healthy worker is paused, endpoint answering without health is engine-up', () => {
  const a = catalogueEntry({ member: member('glm53f-m3'), worker: worker('glm53f-m3', { drained: true }), device: device('glm53f-m3'), mediaBusy: false, now: NOW });
  assert.equal(a.state, 'paused');
  const b = catalogueEntry({ member: member('glm53f-m3'), worker: worker('glm53f-m3', { is_healthy: false, probe_error: 'PROBE_TIMEOUT', last_probe: new Date(NOW - 9000).toISOString() }), device: { ...device('glm53f-m3'), endpoint_metrics: { connected: true, running: 1, at: NOW } }, mediaBusy: false, now: NOW });
  assert.equal(b.state, 'engine-up');
  assert.match(b.detail, /PROBE_TIMEOUT/);
  assert.match(b.detail, /9s ago/);
});

test('catalogue: media workload outranks routing state and is reported as actual machine use', () => {
  const a = catalogueEntry({ member: member('spark2'), worker: worker('spark2', { is_healthy: false }), device: device('spark2'), mediaBusy: true, mediaDetail: 'video · running · frame 40%', now: NOW });
  assert.equal(a.state, 'serving-media');
  assert.match(a.detail, /video/);
  const { entries } = buildCatalogue({
    members: [member('spark2'), member('glm53f-sparks12')],
    workers: [worker('glm53f-sparks12', { load: 1 })],
    devices: [device('spark2', { endpoint_metrics: { connected: false, running: 0, at: 1000 } })],
    media: { workloads: [{ worker_id: 'spark2', kind: 'video', state: 'running', phase: 'sampling' }], native_engines: [{ worker_id: 'spark2', kind: 'video', state: 'busy', observed_at: NOW - 3000 }] },
    routes: {},
    now: NOW
  });
  assert.equal(entries[0].id, 'spark2');
  assert.equal(entries[0].state, 'serving-media');
  assert.ok(CATALOGUE_RANK[entries[0].state] < CATALOGUE_RANK[entries[1].state]);
});

test('catalogue: quarantined is failed; stale native engines do not count as busy', () => {
  const a = catalogueEntry({ member: member('spark2'), worker: worker('spark2', { quarantine: true, quarantine_reason: 'repeated probe failures' }), device: device('spark2'), mediaBusy: false, now: NOW });
  assert.equal(a.state, 'failed');
  assert.match(a.detail, /repeated probe failures/);
  const { entries } = buildCatalogue({
    members: [member('spark2')],
    workers: [],
    devices: [device('spark2', { endpoint_metrics: { connected: false, running: 0, at: 1000 } })],
    media: { workloads: [], native_engines: [{ worker_id: 'spark2', kind: 'video', state: 'busy', observed_at: NOW - 60000 }] },
    routes: {},
    now: NOW
  });
  assert.notEqual(entries[0].state, 'serving-media');
});

test('catalogue: warnings flag routes to dead workers and unenrolled gateway workers, never auto-repair', () => {
  const { warnings } = buildCatalogue({
    members: [member('glm53f-sparks12')],
    workers: [worker('glm53f-sparks12'), worker('ds41-m3', { is_healthy: false })],
    devices: [],
    routes: { 'deepseek-v4.1-flash-m3': ['ds41-m3'], orphan: ['ghost-worker'] },
    now: NOW
  });
  assert.ok(warnings.some(w => w.includes('route deepseek-v4.1-flash-m3 targets ds41-m3, which is not healthy')));
  assert.ok(warnings.some(w => w.includes('route orphan targets ghost-worker, which has no enrolled scripts')));
  assert.ok(warnings.some(w => w.includes('ds41-m3 has no enrolled power scripts')));
});

test('catalogue: direct_reserved and served_model pass through for Genie agreement', () => {
  const a = catalogueEntry({ member: member('glm53f-m3'), worker: worker('glm53f-m3', { served_model: 'GLM-5.3-Flash-oQ8e-mtp', direct_reserved: true }), device: device('glm53f-m3'), mediaBusy: false, now: NOW });
  assert.equal(a.served_model, 'GLM-5.3-Flash-oQ8e-mtp');
  assert.equal(a.state, 'paused');
  assert.match(a.detail, /reserved for direct work/);
  assert.doesNotMatch(a.detail, /operator/);
});

test('catalogue: maintenance does not invent an operator pause or current endpoint proof', () => {
  const target = worker('fixture-model', { drained: true, operator_paused: false, maintenance_locks: [{ name: 'Recipe trial' }] });
  const value = catalogueEntry({ member: member('fixture-model'), worker: target, device: device('fixture-model'), now: NOW });
  assert.equal(value.state, 'paused');assert.match(value.detail, /held for maintenance; endpoint answering/);
  assert.doesNotMatch(value.detail, /operator/);
  const unknown = catalogueEntry({ member: member('fixture-model'), worker: target, device: null, now: NOW });
  assert.match(unknown.detail, /current endpoint telemetry unavailable/);
  assert.doesNotMatch(unknown.detail, /engine still up|endpoint answering/);
  const both = catalogueEntry({ member: member('fixture-model'), worker: { ...target, operator_paused: true }, device: device('fixture-model'), now: NOW });
  assert.match(both.detail, /paused by operator and held for maintenance/);
});
