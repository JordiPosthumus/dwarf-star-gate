// A pinned, auditable compatibility patch to upstream Hermes. Its native
// Telegram adapter remains the channel implementation. DSG must preserve the
// owner's pending messages during cold starts and conflict recovery.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
export const NATIVE_POLICY_VERSION=2;
const file='plugins/platforms/telegram/adapter.py';
export function telegramPreservationPatch(original){
  const startup='drop_pending_updates=not is_reconnect';
  const recovery='app, drop_pending_updates=True, error_callback=self._polling_error_callback_ref';
  if(original.split(startup).length!==3||original.split(recovery).length!==2)throw Error('Pinned Hermes Telegram policy sites changed; review the native adapter before installation');
  return original.replaceAll(startup,startup+' and not self.config.extra.get("preserve_pending_updates", False)')
    .replace(recovery,'app, drop_pending_updates=not self.config.extra.get("preserve_pending_updates", False), error_callback=self._polling_error_callback_ref');
}
export function nativeAdmissionPatch(original){
  const site='        # On-entry self-heal: clear a guard whose owner task already exited.';
  if(original.split(site).length!==2)throw Error('Pinned Hermes native admission site changed; review before installation');
  const debounce='        state.task = asyncio.create_task(self._flush_text_debounce(session_key, delay))';
  const merged='                    merge_pending_message_event(self._pending_messages, session_key, event, merge_text=True)';
  if(original.split(debounce).length!==2||original.split(merged).length!==2)throw Error('Pinned Hermes debounce admission sites changed; review before installation');
  return original.replace(debounce,debounce+'\n        event._gateway_accepted = True')
    .replace(merged,merged+'\n                    event._gateway_accepted = True')
    .replace(site,`        # DSG opt-in exact-turn hold; exceptions must not fall through to admission.
        if os.environ.get("DSG_NATIVE_SESSION_CONTROLS") == "1":
            from genie_native_controls import gate_native_message
            if gate_native_message(self, event, session_key):
                return
`+site);
}
const patches=new Map([[file,telegramPreservationPatch],['gateway/platforms/base.py',nativeAdmissionPatch]]);
function sourceState(source,env){
  const git=args=>execFileSync('git',args,{cwd:source,env,encoding:'utf8'});
  const changed=git(['diff','--name-only','HEAD']).trim().split('\n').filter(Boolean);
  const files=[...patches].map(([name,patch])=>{const original=git(['show','HEAD:'+name]);return {name,original,expected:patch(original),current:fs.readFileSync(path.join(source,name),'utf8')};});
  return {changed,files};
}
export function applyNativeHermesPolicy(source,env){
  const state=sourceState(source,env);
  if(state.changed.some(name=>!patches.has(name))||state.files.some(f=>f.current!==f.original&&f.current!==f.expected))throw Error('Refusing to replace changes in the native Hermes source');
  // Resume only this exact patch after an interrupted dependency installation.
  for(const f of state.files)if(f.current!==f.expected)fs.writeFileSync(path.join(source,f.name),f.expected);
}
export function verifyNativeHermesPolicy(source,env){
  const state=sourceState(source,env);
  return state.changed.length===patches.size&&state.changed.every(name=>patches.has(name))&&state.files.every(f=>f.current===f.expected);
}
