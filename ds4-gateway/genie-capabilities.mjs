// Independent feature switches, stored in the gateway's existing metadata.
export const genieCapabilityKeys=['fleet_reviews','rebalance','research','inspection','server_changes','hourglass','media','spark_setup'];
export function validateGenieCapabilities(value={}) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([key,v])=>!genieCapabilityKeys.includes(key)||typeof v!=='boolean'))throw new Error('Invalid Genie capability switches');
  return value;
}
export function genieCapabilities(saved,config,recovery) {
  return {...Object.fromEntries(genieCapabilityKeys.map(key=>[key,key==='spark_setup'?config.spark_setup?.enabled===true:key==='media'?config.media_jobs?.execution_enabled===true:key==='rebalance'?config.genie_load_balancing!==false:true])),...validateGenieCapabilities(saved),recovery:recovery===true};
}
