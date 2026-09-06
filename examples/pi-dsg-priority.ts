// Load explicitly for an existing DSG provider. Preserves Pi's inference transport.
// Shares a title and bounded latest-user excerpt; /priority-lens off opts out.
import {openAICompletionsApi} from '@earendil-works/pi-ai';
import {registerPiPriorityLens} from '../ds4-gateway/pi-priority-client.mjs';
export default function(pi){
  const {streamSimple}=openAICompletionsApi();
  registerPiPriorityLens(pi,{provider:process.env.DSG_PI_PROVIDER,baseUrl:process.env.DSG_PI_BASE_URL,streamSimple,enabled:process.env.DSG_PRIORITY_LENS!=='0'});
}
