import http from 'node:http';
const paths = new Set(['/workers', '/add-worker', '/remove-worker', '/drain-workers', '/resume-workers', '/set-context-limit','/recovery-policy','/recover-worker','/genie-recover-worker','/recovery-canary','/recovery-recheck','/predictor','/genie-predictor']);
export function workerControl(socketPath, route, body) {
  if (!socketPath || !paths.has(route)) return Promise.reject(new Error('Worker control socket not configured'));
  return new Promise((resolve, reject) => {
    // Controls are infrequent. A fresh socket avoids reusing a half-closed
    // keep-alive connection after the gateway restarts; never replay mutations.
    const req = http.request({ socketPath, path: route, agent:false, method: route === '/workers' ? 'GET' : 'POST', headers:{'content-type':'application/json'} }, res => {
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
