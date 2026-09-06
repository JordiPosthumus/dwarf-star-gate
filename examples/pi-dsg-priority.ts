// Load explicitly for an existing DSG provider. Preserves Pi's inference transport.
// Shares a title and bounded latest-user excerpt; /priority-lens off opts out.
import {streamSimple} from '@earendil-works/pi-ai/api/openai-completions';
import {registerPiPriorityLens} from '../ds4-gateway/pi-priority-client.mjs';
export default function(pi){
  registerPiPriorityLens(pi,{provider:process.env.DSG_PI_PROVIDER,baseUrl:process.env.DSG_PI_BASE_URL,streamSimple,enabled:process.env.DSG_PRIORITY_LENS!=='0'});
}
