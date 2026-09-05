// Offline challenger only: socket delivery timing is not engine decode timing.
// Do not edit the V1 builder: frozen V1 artifacts keep their exact feature hash.
import {replayOccupancy} from './occupancy.mjs';
export const DELIVERY_FEATURE_SCHEMA='dsg-delivery-aware-v1';
const renamed={prior_generation_tps:'prior_stream_delivery_tps',worker_generation_tps:'worker_stream_delivery_tps',history_generation_estimate_s:'history_delivery_estimate_s'};
const additions=['prior_stream_window_s','prior_stream_window_fraction','prior_service_output_tps'];
const nonnegative=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;

export function deliveryFeatures(original){
  const features=Object.fromEntries(Object.entries(original).map(([key,value])=>[renamed[key]??key,value]));
  const service=original.prior_service_s,first=original.prior_ttft_s,tokens=original.prior_output_tokens;
  const window=nonnegative(service)&&nonnegative(first)&&first<=service?service-first:null;
  Object.assign(features,{prior_stream_window_s:window,
    prior_stream_window_fraction:window!==null&&service>0?window/service:null,
    prior_service_output_tps:nonnegative(tokens)&&nonnegative(service)&&service>0?tokens/service:null});
  return features;
}

export function replayDeliveryOccupancy(events,inventory){
  const original=replayOccupancy(events,inventory);
  const groups=Object.fromEntries(Object.entries(original.groups).map(([group,names])=>[group,names.map(name=>renamed[name]??name)]));
  groups.history=[...groups.history,...additions];
  return {...original,schema:'dsg-occupancy-v2',feature_schema:DELIVERY_FEATURE_SCHEMA,
    groups,feature_names:Object.values(groups).flat(),
    rows:original.rows.map(row=>({...row,features:deliveryFeatures(row.features)})),
    limitations:[...original.limitations,
      'Delivery rates describe first-visible-content to response completion, not engine decode speed.',
      'Service-output rate includes all observed service time, not just decoding. No hardware speed cap is imposed.',
      'Renamed delivery estimates remain optional XGB inputs, never the hard-coded causal generation-time anchor.']};
}
