import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {mediaRuntimeScript} from './media-runtime.mjs';

const folder=path.resolve(process.argv[2]);
const plan=JSON.parse(fs.readFileSync(path.join(folder,'plan.json'),'utf8'));
// Validate before loading the runner or any native-operation dependencies.
await import(pathToFileURL(mediaRuntimeScript(folder,plan,'media-runner.mjs')).href);
