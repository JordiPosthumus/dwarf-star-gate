// Read-only local DS4 log adapter. Paths and raw lines never enter snapshots.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseTiming } from './telemetry.mjs';

const READ_BYTES = 256 * 1024, LINE_BYTES = 64 * 1024, HISTORY_MS = 15 * 60000;
export function telemetryFiles(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid telemetry_files map');
  const files = new Map();
  for (const [id, file] of Object.entries(raw)) {
    if (!/^[a-zA-Z0-9][\w-]{0,63}$/.test(id) || typeof file !== 'string' || !path.isAbsolute(file) || file.length > 4096 || file.includes('\0'))
      throw new Error('telemetry_files requires worker IDs and absolute local file paths');
    files.set(id, file);
  }
  return files;
}

// DS4's MMDD HH:MM:SS prefix has no year or zone. This adapter is for a local
// engine using the dashboard host's clock/zone; choose the nearest valid year.
export function parseLocalTiming(line, now = Date.now()) {
  const m = line.match(/^(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2}) ds4-server: /);
  if (!m) return null;
  const [month, day, hour, minute, second] = m.slice(1).map(Number);
  const year = new Date(now).getFullYear(), dates = [];
  for (const y of [year - 1, year, year + 1]) {
    const date = new Date(y, month - 1, day, hour, minute, second);
    if (date.getMonth() === month - 1 && date.getDate() === day && date.getHours() === hour && date.getMinutes() === minute && date.getSeconds() === second) dates.push(+date);
  }
  if (!dates.length) return null;
  const time = dates.sort((a,b) => Math.abs(a-now)-Math.abs(b-now))[0];
  if (time < now - HISTORY_MS || time > now + 5000) return null;
  return parseTiming(line, time);
}

export class FileLogReader {
  constructor(device, file, save = () => {}) {
    telemetryFiles({ [device.id]:file });
    this.device = device; this.file = file; this.save = save;
    this.identity = null; this.offset = 0; this.anchor = Buffer.alloc(0);
    this.fragment = Buffer.alloc(0); this.skipping = false; this.seen = new Set();
  }
  poll(now = Date.now()) {
    let fd;
    try {
      // Reject symlinks and special files before opening; O_NOFOLLOW/O_NONBLOCK
      // and fstat close the replacement/FIFO race. Never create or modify a log.
      if (!fs.lstatSync(this.file).isFile()) throw new Error('Not a regular log');
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error('Not a regular log');
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let reset = identity !== this.identity || stat.size < this.offset;
      if (!reset && this.anchor.length) {
        const check = Buffer.alloc(this.anchor.length);
        const n = fs.readSync(fd, check, 0, check.length, this.offset - check.length);
        reset = n !== check.length || !check.equals(this.anchor);
      }
      // Copy-truncate-and-regrow is detected by the trailing byte anchor even
      // when the file has already grown past our old offset between polls.
      if (reset) {
        this.identity = identity; this.offset = Math.max(0, stat.size - READ_BYTES);
        this.fragment = Buffer.alloc(0); this.skipping = this.offset > 0;
        this.anchor = Buffer.alloc(0);
      }
      const start = this.offset, length = Math.min(READ_BYTES, Math.max(0, stat.size - start));
      const chunk = Buffer.alloc(length);
      const n = length ? fs.readSync(fd, chunk, 0, length, start) : 0;
      this.offset += n;
      const base = start - this.fragment.length;
      const buffer = Buffer.concat([this.fragment, chunk.subarray(0,n)]);
      let from = 0, end;
      while ((end = buffer.indexOf(10, from)) >= 0) {
        if (!this.skipping && end - from <= LINE_BYTES) {
          const event = parseLocalTiming(buffer.subarray(from,end).toString('utf8').replace(/\r$/, ''), now);
          if (event) {
            // Stable restart/replay IDs use only file identity, byte location and
            // allowlisted parsed values, never the path or raw message text.
            const sample = createHash('sha256').update(`${this.device.id}:${identity}:${base+from}:${JSON.stringify(event)}`).digest('hex');
            if (!this.seen.has(sample)) {
              this.seen.add(sample);
              if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value);
              this.device.accept(event); this.save({ sample_id:sample, observed_at:now, node:this.device.id, ...event });
            }
          }
        }
        this.skipping = false; from = end + 1;
      }
      this.fragment = Buffer.from(buffer.subarray(from));
      if (this.fragment.length > LINE_BYTES || this.skipping) { this.fragment = Buffer.alloc(0); this.skipping = true; }
      this.anchor = Buffer.alloc(Math.min(64, this.offset));
      if (this.anchor.length) {
        const read = fs.readSync(fd,this.anchor,0,this.anchor.length,this.offset-this.anchor.length);
        this.anchor = this.anchor.subarray(0,read);
      }
      this.device.connected = true;
    } catch { this.device.connected = false; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}
