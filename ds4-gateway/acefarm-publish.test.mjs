import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('AceFarm publication preserves canonical artifacts across retries and refuses mismatched native evidence',()=>{
  execFileSync(process.env.PYTHON??'python3',['-B',fileURLToPath(new URL('./acefarm_publish_test.py',import.meta.url)),'-v'],{stdio:'pipe',timeout:60000});
});
