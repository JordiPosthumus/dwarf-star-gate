// Operator-supplied routing endpoints only. No model launch commands or settings.
const keys = new Set(['id', 'url', 'ssh', 'ssh_fallbacks', 'remote_port', 'telemetry_service']);
const validSshAlias=value=>typeof value==='string'&&/^[a-zA-Z0-9][\w.@-]{0,252}$/.test(value);
const fallbackList=(value,primary)=>{
  if(!Array.isArray(value)||value.length>4||value.some(alias=>!validSshAlias(alias)))throw new Error('SSH fallbacks must be an array of at most four host aliases');
  const fallbacks=[...new Set(value)];
  if(fallbacks.includes(primary))throw new Error('Primary SSH alias cannot also be a fallback');
  return fallbacks;
};
export function sshTargets(worker) {
  return worker?.ssh?[worker.ssh,...(worker.ssh_fallbacks??[])]:[];
}
export function workerConfig(raw, { registration = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !keys.has(k))) throw new Error('Unsupported worker configuration field');
  if (typeof raw.id !== 'string' || !/^[a-zA-Z0-9][\w-]{0,63}$/.test(raw.id)) throw new Error('Worker ID must use 1–64 letters, digits, underscores or hyphens');
  const u = new URL(raw.url);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || !u.port || u.username || u.password || u.search || u.hash || !['/', '/v1', '/v1/'].includes(u.pathname)) throw new Error('Use a local HTTP endpoint or an SSH tunnel to a local port');
  const result = { id: raw.id, url: `http://127.0.0.1:${u.port}` };
  if (raw.ssh !== undefined) {
    if (!validSshAlias(raw.ssh)) throw new Error('Invalid SSH host or alias');
    result.ssh = raw.ssh;
    if(raw.ssh_fallbacks!==undefined){
      const fallbacks=fallbackList(raw.ssh_fallbacks,raw.ssh);
      if(fallbacks.length)result.ssh_fallbacks=fallbacks;
    }
    const port = raw.remote_port ?? 8000;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Remote port must be 1–65535');
    if (raw.remote_port !== undefined) result.remote_port = port;
  } else if (raw.remote_port !== undefined || raw.ssh_fallbacks !== undefined) throw new Error('Remote port and SSH fallbacks require a primary SSH alias');
  if (raw.telemetry_service !== undefined) {
    if (raw.telemetry_service !== null && (typeof raw.telemetry_service !== 'string' || !/^[\w@.-]+\.service$/.test(raw.telemetry_service))) throw new Error('Invalid journal service');
    result.telemetry_service = raw.telemetry_service;
  } else if (registration) result.telemetry_service = null; // Macs need not have journalctl.
  return result;
}
export function workerConfigs(raw) {
  if (!Array.isArray(raw)) throw new Error('Worker list must be an array');
  const list = raw.map(n => workerConfig(n));
  for (let i = 0; i < list.length; i++) assertUniqueWorker(list.slice(0, i), list[i]);
  return list;
}
export function assertUniqueWorker(list, worker) {
  if (list.some(n => n.id === worker.id)) throw new Error('Worker ID already registered');
  if (list.some(n => n.url === worker.url)) throw new Error('Local endpoint already registered');
  if (worker.ssh && list.some(n => (n.remote_port ?? 8000) === (worker.remote_port ?? 8000) && sshTargets(n).some(alias=>sshTargets(worker).includes(alias)))) throw new Error('SSH endpoint already registered');
}

// Optimistic, management-only edit. The inference URL, primary route, remote
// port, telemetry and worker identity are immutable here.
export function replaceSshFallbacks(rawList,input) {
  const list=workerConfigs(rawList);
  if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='expected_ssh_fallbacks,id,ssh_fallbacks'||typeof input.id!=='string')throw new Error('Specify worker ID, expected fallbacks and replacement fallbacks only');
  const index=list.findIndex(worker=>worker.id===input.id);
  if(index<0)throw new Error('Unknown worker');
  const current=list[index];
  if(!current.ssh)throw new Error('SSH fallbacks require a remote worker');
  const expected=fallbackList(input.expected_ssh_fallbacks,current.ssh),replacement=fallbackList(input.ssh_fallbacks,current.ssh);
  if(JSON.stringify(expected)!==JSON.stringify(current.ssh_fallbacks??[]))throw new Error('SSH fallbacks changed; refresh before applying');
  const candidate=workerConfig({...current,ssh_fallbacks:replacement});
  assertUniqueWorker(list.filter((_,i)=>i!==index),candidate);
  return list.map((worker,i)=>i===index?candidate:worker);
}
