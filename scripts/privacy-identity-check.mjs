// Commit metadata is public too. Diagnostics deliberately omit identity values.
import {execFileSync} from 'node:child_process';

try {
  const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  let approved=[];
  try {approved=git('config','--local','--get-all','dsg.publicEmail').split('\n');}
  catch (error) {if(error.status!==1) throw error;}
  for (const kind of ['AUTHOR','COMMITTER']) {
    const identity=git('var',`GIT_${kind}_IDENT`);
    const email=identity.match(/<([^<>]+)>\s+\d+\s+[+-]\d+$/)?.[1];
    if (!email || !(/^[^@\s]+@users\.noreply\.github\.com$/i.test(email) || /^[^@\s]+@example\.invalid$/i.test(email) || approved.includes(email))) {
      throw new Error(`Publication blocked: ${kind.toLowerCase()} email is not privacy-safe or explicitly approved. Use your verified GitHub noreply address, or deliberately approve a public address with local dsg.publicEmail. No identity value was printed.`);
    }
  }
} catch (error) {
  console.error(error.message?.startsWith('Publication blocked:') ? error.message : 'Publication blocked: commit identity could not be verified.');
  process.exitCode=1;
}
