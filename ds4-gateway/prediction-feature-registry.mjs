import fs from 'node:fs';
import {createHash} from 'node:crypto';
import * as v2 from './prediction-features.mjs';
import * as v3 from './prediction-features-v3.mjs';
import * as v4 from './prediction-features-v4.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const entries=new Map([
  [v2.FEATURE_SCHEMA,{...v2,dependencies:[new URL('./prediction-features.mjs',import.meta.url)]}],
  // V3 subclasses V2. Its fingerprint therefore covers both implementations;
  // otherwise a V2 edit could silently change V3 inference without invalidating
  // a trained artifact. The one-file V2 fingerprint intentionally stays exactly
  // compatible with already-deployed V2 bundles.
  [v3.FEATURE_SCHEMA,{...v3,dependencies:[
    new URL('./prediction-features.mjs',import.meta.url),
    new URL('./prediction-features-v3.mjs',import.meta.url)
  ]}],
  [v4.FEATURE_SCHEMA,{...v4,dependencies:[new URL('./prediction-features.mjs',import.meta.url),new URL('./prediction-features-v3.mjs',import.meta.url),new URL('./prediction-features-v4.mjs',import.meta.url),new URL('./prediction-hardware.mjs',import.meta.url)]}]
]);

export const CURRENT_FEATURE_SCHEMA=v3.FEATURE_SCHEMA;
export function featureContract(schema=CURRENT_FEATURE_SCHEMA) {
  const contract=entries.get(schema);if(!contract)throw new Error('Unsupported predictor feature schema');return contract;
}
export function featureBuilderHash(schema=CURRENT_FEATURE_SCHEMA) {
  const files=featureContract(schema).dependencies;
  return hash(Buffer.concat(files.map(url=>fs.readFileSync(url))));
}
export function featureSchemas(){return [...entries.keys()];}
