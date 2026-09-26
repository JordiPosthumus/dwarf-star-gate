import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const execute=promisify(execFile),script=fileURLToPath(new URL('./recovery_media_bridge.py',import.meta.url));

// The private plan supplies all hosts, profiles and ownership. Callers select
// only a fixed role/member transition and its already captured exact container.
export function createMediaCommandBridge(plan,folder,{run=execute,wait=delay,save=()=>{}}={}){
  const call=async(...args)=>JSON.parse((await run(plan.python,['-I','-B',script,folder,...args],{maxBuffer:1024*1024})).stdout);
  const exact=(row,step)=>{
    assert.equal(row?.operation_id,plan.operation_id,'Native command operation differs');
    if(step)assert.equal(row.step,step,'Native command step differs');
    return row;
  };
  return {
    async prepare(){
      const row=exact(await call('prepare'));
      if(row.state==='recipe_unverified')throw Error(`ACE-Step support for ${(plan.required_recipe_fields??[]).join(', ')} is not verified on every selected engine. Qualify a compatible image; no LLM was drained or generation submitted.`);
      assert.equal(row.state,'prepared','Native command bindings were not prepared');return row;
    },
    async command(action,role,member,container){
      assert.ok(['start','stop'].includes(action)&&['llm','media'].includes(role)&&[0,1].includes(member)&&/^[a-f0-9]{64}$/.test(container));
      const step=`${role}-${action}-${member}`;let mode='run';
      for(;;){
        let row;
        try{row=exact(await call(mode,step,container),step);}
        catch{row={state:'observation_unavailable',operation_id:plan.operation_id,step};}
        save(`command-${step}-observation.json`,row);
        if(row.state==='completed')return row;
        if(row.state==='exited')throw Error(`Native ${step} was acknowledged but its exact container exited; no generation was submitted by this start.`);
        if(row.state==='refused'&&row.command_issued===false)throw Error(`Native ${step} was refused before command dispatch; original receipt retained.`);
        // A lost response or missing receipt is never a second submission.
        // Only affirmative prepared/no-runner evidence or an observed result
        // permits the journal to continue its SAME request. Intent cannot replay.
        mode=row.runner_active===false&&(row.state==='prepared'||['intent','acknowledged'].includes(row.state)&&row.outcome==='observed')?'run':'status';
        await wait(3000);
      }
    },
  };
}
