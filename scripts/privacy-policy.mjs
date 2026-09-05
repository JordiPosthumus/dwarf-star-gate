// Publication guardrails, not a semantic privacy proof. Never report matched values.
export const forbiddenPath = /(?:^|\/)(?:runtime|sessions|snapshots|backups|training|artifacts|private|local-notes|\.venv|__pycache__|\.pi|pi-setup|node_modules)(?:\/|$)|(?:^|\/)(?:auth|models-store|config\.local|config\.production|config\.candidate|worker-profiles\.local)\.json$|(?:^|\/)\.env(?:\.|$)|\.(?:kv|gguf|ubj|pyc|key|pem|log|jsonl|plist)$|\.bak|(?:^|\/)(?:recovery-canary|deployment-receipt|incident-report)-\d{4}-\d{2}-\d{2}/;

const privatePatterns = [
  ['non-example email', /\b[A-Z0-9._%+-]+@(?!example\.(?:invalid|com|org|net)\b|users\.noreply\.github\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ['URL credentials', /https?:\/\/[^\s/"'<>]+:[^\s/"'<>]+@/i],
  ['cloud credential-shaped token', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bxox[baprs]-[a-zA-Z0-9-]{20,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['private temporary path', /\/(?:private\/)?var\/folders\/|\/private\/tmp\/dsg-/],
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
  // Screenshots need visual review too; refuse hidden text/EXIF payloads without
  // printing their contents. Signature detection also covers renamed PNGs.
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    let offset=8, ended=false;
    while (offset+12<=bytes.length) {
      const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);
      if (offset+length+12>bytes.length) break;
      if (['tEXt','iTXt','zTXt','eXIf'].includes(type)) labels.push('PNG private-metadata risk');
      offset+=length+12;
      if (type==='IEND') {ended=length===0 && offset===bytes.length;break;}
    }
    if (!ended) labels.push('unreviewable PNG structure or trailing data');
    // Compressed pixel bytes can accidentally resemble email/text. Metadata is
    // checked above; visual contents require the separate screenshot review.
    return labels;
  }
  const text = bytes.toString('utf8');
  for (const [label, pattern] of privatePatterns) if (pattern.test(text)) labels.push(label);
  // Prose heuristics also cover inline dashboard copy, but not source test fixtures.
  if (/\.(?:md|html)$/i.test(file)) {
    for (const [label, pattern] of operationalPatterns) if (pattern.test(text)) labels.push(label);
  }
  return labels;
}
