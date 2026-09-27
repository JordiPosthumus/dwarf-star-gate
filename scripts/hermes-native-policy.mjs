// A pinned, auditable compatibility patch to upstream Hermes. Its native
// Telegram adapter remains the channel implementation. DSG must preserve the
// owner's pending messages during cold starts and conflict recovery.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
export const NATIVE_POLICY_VERSION=1;
const file='plugins/platforms/telegram/adapter.py';
export function telegramPreservationPatch(original){
  const startup='drop_pending_updates=not is_reconnect';
  const recovery='app, drop_pending_updates=True, error_callback=self._polling_error_callback_ref';
  if(original.split(startup).length!==3||original.split(recovery).length!==2)throw Error('Pinned Hermes Telegram policy sites changed; review the native adapter before installation');
  return original.replaceAll(startup,startup+' and not self.config.extra.get("preserve_pending_updates", False)')
    .replace(recovery,'app, drop_pending_updates=not self.config.extra.get("preserve_pending_updates", False), error_callback=self._polling_error_callback_ref');
}
function sourceState(source,env){
  const git=args=>execFileSync('git',args,{cwd:source,env,encoding:'utf8'});
  const original=git(['show','HEAD:'+file]);
  const changed=git(['diff','--name-only','HEAD']).trim().split('\n').filter(Boolean);
  return {original,expected:telegramPreservationPatch(original),changed,current:fs.readFileSync(path.join(source,file),'utf8')};
}
export function applyNativeHermesPolicy(source,env){
  const state=sourceState(source,env);
  // A dependency download may have stopped after this exact patch was applied.
  if(state.changed.length===1&&state.changed[0]===file&&state.current===state.expected)return;
  if(state.changed.length||state.current!==state.original)throw Error('Refusing to replace changes in the native Hermes source');
  fs.writeFileSync(path.join(source,file),state.expected);
}
export function verifyNativeHermesPolicy(source,env){
  const state=sourceState(source,env);
  return state.changed.length===1&&state.changed[0]===file&&state.current===state.expected;
}
