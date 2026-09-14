import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const DAY=86400000,UUID=/^[a-f0-9-]{36}$/;
export const STUDY_PROMPT='Look for worthwhile improvements to my setup. Give me your best recommendation, with sources, the configuration you studied, and any tradeoffs.';
export const STUDY_INSTRUCTIONS='For this setup research, use current public documentation and upstream changes. Start from approved configuration records; where approval is missing, explicitly label observations as unapproved. Cite exact configuration revisions and dated public sources. Present one short, best-supported recommendation at a time: exact change, reason, expected benefit, tradeoff and verification. Separate published measurements from hypotheses; do not invent gains. Say when nothing is sufficiently supported. Research permission does not authorize benchmarks, installations, draining, restarting or server changes.';

// One private reminder record; existing chat owns execution and history.
// Reading a due reminder never invokes a model. Each study needs a UI action.
export class GenieStudy {
  constructor(chat,{now=Date.now}={}){
    this.chat=chat;this.now=now;this.file=path.join(chat.directory,'research-plan.json');this.error=null;
    this.plan={version:1,revision:0,interval_days:0,next_due_at:null,last_run:null};
    let fd;
    try{
      fd=fs.openSync(this.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>65536)throw new Error();
      const p=JSON.parse(fs.readFileSync(fd,'utf8'));
      if(p.version!==1||!Number.isSafeInteger(p.revision)||p.revision<0||![0,1,7,14,30].includes(p.interval_days)||
        (p.next_due_at!==null&&(!Number.isSafeInteger(p.next_due_at)||p.next_due_at<0))||
        (p.interval_days>0&&p.next_due_at===null)||
        (p.last_run!==null&&(!UUID.test(p.last_run.conversation_id)||!UUID.test(p.last_run.request_id)||!Number.isSafeInteger(p.last_run.at))))throw new Error();
      this.plan=p;
    }catch(e){if(e.code!=='ENOENT')this.error='Research reminders could not be read. The existing file was preserved.';}
    finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  status(){
    const p=this.plan;let last=null;
    if(p.last_run){
      let conversation;try{conversation=this.chat.get(p.last_run.conversation_id);}catch{}
      const reply=conversation?.messages.find((m,i)=>m.role==='assistant'&&conversation.messages[i-1]?.request_id===p.last_run.request_id);
      last={conversation_id:p.last_run.conversation_id,request_id:p.last_run.request_id,at:p.last_run.at,state:reply?.state??'not_started'};
    }
    return {version:1,revision:p.revision,interval_days:p.interval_days,next_due_at:p.next_due_at,last_run:last,due:p.interval_days>0&&p.next_due_at<=this.now(),error:this.error,
      available:!this.error&&!!this.chat.provider?.info?.research_available&&!this.chat.closed&&!this.chat.isSuspended()};
  }
  save(plan){
    const temp=`${this.file}.${randomUUID()}.tmp`;
    try{fs.writeFileSync(temp,JSON.stringify(plan),{flag:'wx',mode:0o600});fs.renameSync(temp,this.file);this.plan=plan;}
    finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  change(input){
    if(this.error)throw new Error(this.error);
    const keys={'study-schedule':['action','expected_revision','interval_days'],'study-postpone':['action','expected_revision'],'study-skip':['action','expected_revision'],'study-start':['action','expected_revision','request_id']}[input?.action];
    if(!keys||Object.keys(input).length!==keys.length||!keys.every(k=>Object.hasOwn(input,k)))throw new Error('Invalid research control.');
    if(input.action==='study-start'&&input.request_id===this.plan.last_run?.request_id)return this.status();
    if(input.expected_revision!==this.plan.revision)throw new Error('Research controls changed. Refresh before trying again.');
    const p={...this.plan,revision:this.plan.revision+1},now=this.now();
    if(input.action==='study-schedule'){
      if(![0,1,7,14,30].includes(input.interval_days))throw new Error('Choose one of the offered reminder intervals.');
      p.interval_days=input.interval_days;p.next_due_at=p.interval_days?now+p.interval_days*DAY:null;
    }else if(input.action==='study-postpone'||input.action==='study-skip'){
      if(!this.status().due)throw new Error('There is no research reminder due.');
      p.next_due_at=now+(input.action==='study-postpone'?1:p.interval_days)*DAY;
    }else{
      if(!this.status().available)throw new Error('Connect Genie and web research before starting a study.');
      if(!UUID.test(input.request_id??''))throw new Error('A study request identifier is required.');
      if(this.status().last_run?.state==='working')throw new Error('A study is already running. Open its conversation.');
      const conversation=this.chat.create({title:`Setup research · ${new Date(now).toISOString().slice(0,10)}`,purpose:'setup_research'});
      p.last_run={conversation_id:conversation.id,request_id:input.request_id,at:now};
      p.next_due_at=p.interval_days?now+p.interval_days*DAY:null;
      // Persist intent first. An uncertain submission is never automatically replayed.
      this.save(p);this.chat.submit(conversation.id,STUDY_PROMPT,input.request_id,{research:true});
      return this.status();
    }
    this.save(p);return this.status();
  }
}
