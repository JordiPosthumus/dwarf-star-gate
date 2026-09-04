// Read-only local DS4 log adapter. Paths and raw lines never enter snapshots.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseTiming } from './telemetry.mjs';

const READ_BYTES = 256 * 1024, EPOCH_SCAN_BYTES = 8 * 1024 * 1024, LINE_BYTES = 64 * 1024, HISTORY_MS = 15 * 60000;
const EPOCH_HISTORY_MS = 366 * 24 * 3600000;
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
function localTime(line,now,maxAge) {
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
  if (time < now - maxAge || time > now + 5000) return null;
  return time;
}
export function parseLocalTiming(line, now = Date.now()) {
  const time=localTime(line,now,HISTORY_MS);if(time===null)return null;
  return parseTiming(line, time);
}
export function parseLocalProcessStart(line,now=Date.now()) {
  const time=localTime(line,now,EPOCH_HISTORY_MS);if(time===null||!/ ds4-server: listening on https?:\/\//.test(line))return null;
  return {time,kind:'process_start'};
}
function processEpoch(worker,identity,offset,event) {
  if(!/^[a-zA-Z0-9][\w-]{0,63}$/.test(worker)||typeof identity!=='string'||!Number.isSafeInteger(offset)||offset<0||event?.kind!=='process_start')return null;
  return {...event,backend_epoch:createHash('sha256').update(`dsg-backend-epoch-v1\0${worker}\0local_listen_marker\0${identity}:${offset}:${event.time}`).digest('hex'),
    backend_epoch_source:'local_listen_marker',backend_epoch_confidence:'bounded'};
}

export class FileLogReader {
  constructor(device, file, save = () => {}) {
    telemetryFiles({ [device.id]:file });
    this.device = device; this.file = file; this.save = save;
    this.identity = null; this.offset = 0; this.anchor = Buffer.alloc(0);
    this.fragment = Buffer.alloc(0); this.skipping = false; this.seen = new Set();
  }
  accept(event,identity,offset,now) {
    if(!event)return;
    // Stable restart/replay IDs use only file identity, byte location and
    // allowlisted parsed values, never the path or raw message text.
    const sample=createHash('sha256').update(`${this.device.id}:${identity}:${offset}:${JSON.stringify(event)}`).digest('hex');
    if(this.seen.has(sample))return;
    this.seen.add(sample);if(this.seen.size>5000)this.seen.delete(this.seen.values().next().value);
    this.device.accept(event);this.save({sample_id:sample,observed_at:now,node:this.device.id,...event});
  }
  scanEpoch(fd,stat,now,identity) {
    const start=Math.max(0,stat.size-EPOCH_SCAN_BYTES),length=stat.size-start,chunk=Buffer.alloc(length);
    const n=length?fs.readSync(fd,chunk,0,length,start):0;let from=0,end,last=null;
    if(start){end=chunk.indexOf(10);from=end<0?n:end+1;}
    while((end=chunk.indexOf(10,from))>=0){
      if(end-from<=LINE_BYTES){const line=chunk.subarray(from,end).toString('utf8').replace(/\r$/,'');const event=processEpoch(this.device.id,identity,start+from,parseLocalProcessStart(line,now));if(event)last={event,offset:start+from};}
      from=end+1;
    }
    if(last)this.accept(last.event,identity,last.offset,now);
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
        // A bounded backward scan recovers the latest stock DS4 listen marker
        // after a dashboard restart even when ordinary timing tailing begins
        // later in a large log. Absence remains an explicit unknown epoch.
        this.scanEpoch(fd,stat,now,identity);
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
          const line=buffer.subarray(from,end).toString('utf8').replace(/\r$/,'');
          const event=processEpoch(this.device.id,identity,base+from,parseLocalProcessStart(line,now))??parseLocalTiming(line,now);
          this.accept(event,identity,base+from,now);
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
