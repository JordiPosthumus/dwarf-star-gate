// Pi 0.84.4, explicit enrollment only. Does not register/replace a provider.
// Use this OR DSG_VISUAL_CONTINUITY=1 on pi-dsg-continuity.ts, not both.
import {registerPiVisualContextHook} from '../ds4-gateway/pi-visual-continuity.mjs';
export default function(pi){
  registerPiVisualContextHook(pi,{provider:process.env.DSG_PI_PROVIDER,baseUrl:process.env.DSG_PI_BASE_URL});
}
