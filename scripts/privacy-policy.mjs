// Publication guardrails, not a semantic privacy proof. Never report matched values.
export const forbiddenPath = /(?:^|\/)(?:runtime|sessions|snapshots|backups|training|artifacts|private|local-notes|\.venv|__pycache__|\.pi|pi-setup|node_modules)(?:\/|$)|(?:^|\/)(?:auth|models-store|config\.local|config\.production|config\.candidate|worker-profiles\.local)\.json$|(?:^|\/)\.env(?:\.|$)|\.(?:kv|gguf|ubj|pyc|key|pem|log|jsonl|plist)$|\.bak|(?:^|\/)(?:recovery-canary|deployment-receipt|incident-report)-\d{4}-\d{2}-\d{2}/;

const privatePatterns = [
  ['personal home path', /\/(?:Users|home)\/[a-zA-Z][\w.-]*\//],
  ['private network address', /\b(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/],
  ['private Bonjour hostname', /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.local(?=[:/\s"'<>)]|$)/i],
  ['personal email', /[\w.+-]+@(?:gmail|icloud|hotmail|outlook|yahoo)\.com\b/i],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential-shaped token', /\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,}|sk-[A-Za-z0-9_-]{25,})\b/],
];
const operationalPatterns = [
  ['personal deployment narrative', /\b(?:our|my|the maintainer['’]s)\s+(?:(?:live|production|home|local|private)\s+)*(?:deployment|fleet|gateway|servers?|sparks?|macs?|machines?|installations?)\b/i],
  ['deployment diary heading', /^#{1,6}\s+(?:live recovery canaries|live deployment checkpoint|first real-data smoke result|incident evidence|recorded deployment tests)\b/im],
  ['per-device deployment results', /\b(?:first|second)\s+Spark\b|\bSpark\s+[AB]\s*[:|]/i],
  ['precise operational timestamp', /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\s*(?:UTC|[AP]M)\b/],
  ['raw operation or request identifier', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
];

export function findings(file, bytes) {
  const labels = [];
  if (forbiddenPath.test(file)) labels.push('excluded runtime/private file');
  const text = bytes.toString('utf8');
  for (const [label, pattern] of privatePatterns) if (pattern.test(text)) labels.push(label);
  // Prose heuristics also cover inline dashboard copy, but not source test fixtures.
  if (/\.(?:md|html)$/i.test(file)) {
    for (const [label, pattern] of operationalPatterns) if (pattern.test(text)) labels.push(label);
  }
  return labels;
}
