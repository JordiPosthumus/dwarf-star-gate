import http from 'node:http';
const paths = new Set(['/workers', '/add-worker', '/remove-worker', '/drain-workers', '/resume-workers', '/maintenance-lock','/release-maintenance-lock','/maintenance-receipt','/set-ssh-fallbacks','/set-context-limit','/set-queue-timeout','/set-protection','/relocate-queued','/genie-relocate-queued','/recovery-policy','/recovery-handback-policy','/recover-worker','/genie-recover-worker','/recovery-canary','/recovery-recheck','/predictor','/genie-predictor','/agents','/grant-agent','/revoke-agent','/release-agent-hold']);
export function workerControl(socketPath, route, body, {channel}={}) {
  if (!socketPath || !paths.has(route)) return Promise.reject(new Error('Worker control socket not configured'));
  if(channel!==undefined&&(typeof channel!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(channel)))return Promise.reject(new Error('Invalid worker-control channel'));
  return new Promise((resolve, reject) => {
    // Controls are infrequent. A fresh socket avoids reusing a half-closed
    // keep-alive connection after the gateway restarts; never replay mutations.
    const req = http.request({ socketPath, path: route, agent:false, method: ['/workers','/agents'].includes(route) ? 'GET' : 'POST', headers:{'content-type':'application/json',...(channel?{'x-dsg-control-channel':channel}:{})} }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 1048576) req.destroy(new Error('Control response too large')); });
      res.on('error', reject);
      res.on('end', () => {
        try { const value = JSON.parse(data); if (res.statusCode >= 400) reject(new Error(value.error?.message || 'Worker control failed')); else resolve(value); }
        catch { reject(new Error('Invalid control response')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Worker control timed out; check current registration before retrying')), 30000);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
