import {Readable} from 'node:stream';
import {THINKING_CAPTURE_BYTES} from './requested-thinking.mjs';

// Read-ahead limits only. Neither limit rejects or truncates an upload. Once
// exhausted, the original IncomingMessage keeps its ordinary backpressure until
// dispatch drains this prefix. Nothing is written to disk.
export class QueuedBodyBudget {
  constructor(limit=64*1024*1024){this.limit=limit;this.used=0;this.waiters=new Set();this.scheduled=false;}
  get available(){return Math.max(0,this.limit-this.used);}
  release(bytes){
    this.used-=bytes;
    if(this.scheduled||!this.waiters.size)return;
    this.scheduled=true;
    queueMicrotask(()=>{this.scheduled=false;for(const wake of [...this.waiters])wake();});
  }
}

export class QueuedRequestBody {
  constructor(req,{budget,onBody,limit=THINKING_CAPTURE_BYTES}={}){
    this.req=req;this.budget=budget;this.onBody=onBody;this.limit=limit;
    this.chunks=[];this.bytes=0;this.ended=false;this.disposed=false;
    this.output=null;this.demand=false;this.notified=false;
    this.readable=()=>this.output?this.pull():this.capture();
    this.end=()=>{this.ended=true;if(this.output)this.pull();else this.inspect();};
    this.error=error=>{if(this.output)this.output.destroy(error);else this.dispose();};
    req.on('readable',this.readable);req.once('end',this.end);req.on('error',this.error);
    this.wake=()=>this.capture();
    this.capture();
  }
  capture(){
    if(this.disposed||this.output||this.inspectionStopped)return;
    this.budget.waiters.delete(this.wake);
    while(this.req.readableLength&&this.bytes<this.limit&&this.budget.available){
      const count=Math.min(this.req.readableLength,this.limit-this.bytes,this.budget.available);
      const chunk=this.req.read(count);if(chunk===null)break;
      this.chunks.push(chunk);this.bytes+=chunk.length;this.budget.used+=chunk.length;
    }
    if(this.bytes<this.limit&&!this.budget.available)this.budget.waiters.add(this.wake);
    // Let Node deliver end for a body exactly filling the read-ahead budget.
    this.req.read(0);
    if(this.req.readableEnded){this.ended=true;this.inspect();}
  }
  inspect(){
    if(this.notified||this.disposed||this.inspectionStopped)return;
    this.notified=true;
    try{this.onBody?.(JSON.parse(Buffer.concat(this.chunks,this.bytes).toString('utf8')));}
    catch{/* Optional observation never changes the request or its admission. */}
    this.onBody=null;
  }
  stopInspection(){this.inspectionStopped=true;this.onBody=null;this.budget.waiters.delete(this.wake);}
  stream(){
    if(this.output)return this.output;
    this.budget.waiters.delete(this.wake);
    this.onBody=null;
    const owner=this;
    this.output=new Readable({
      read(){owner.demand=true;owner.pull();},
      destroy(error,done){owner.dispose();done(error);}
    });
    return this.output;
  }
  pull(){
    if(!this.demand||this.disposed)return;
    while(this.chunks.length){
      const chunk=this.chunks.shift();this.bytes-=chunk.length;this.budget.release(chunk.length);
      if(!this.output.push(chunk)){this.demand=false;return;}
    }
    while(this.req.readableLength){
      const chunk=this.req.read(Math.min(this.req.readableLength,this.output.readableHighWaterMark));if(chunk===null)break;
      if(!this.output.push(chunk)){this.demand=false;return;}
    }
    this.req.read(0);
    if(this.ended||this.req.readableEnded){this.demand=false;this.output.push(null);}
  }
  dispose(){
    if(this.disposed)return;
    this.disposed=true;this.onBody=null;
    this.req.off('readable',this.readable);this.req.off('end',this.end);this.req.off('error',this.error);
    this.budget.waiters.delete(this.wake);
    this.chunks=[];const bytes=this.bytes;this.bytes=0;this.budget.release(bytes);
    if(this.output&&!this.output.destroyed)this.output.destroy();
  }
}
