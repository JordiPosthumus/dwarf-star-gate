// Pi 0.84.4. Load explicitly with `pi -e /path/to/DSG/examples/pi-dsg-continuity.ts`.
// Set DSG_PI_PROVIDER and DSG_PI_BASE_URL to an existing DSG provider, not a
// direct DS4 endpoint. No models.json or settings.json changes are performed.
import {streamSimple} from '@earendil-works/pi-ai/api/openai-completions';
import {registerPiContinuity} from '../ds4-gateway/continuity-client.mjs';
export default function(pi){
  registerPiContinuity(pi,{provider:process.env.DSG_PI_PROVIDER,baseUrl:process.env.DSG_PI_BASE_URL,streamSimple,agentWatch:process.env.DSG_AGENT_WATCH==='1',clientMetadata:process.env.DSG_CLIENT_METADATA==='1'});
}
