import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {createSandboxBackend} from '../../host/sandbox-backend.js';
import {fixture,entry} from './fakes.mjs';
const run=async fn=>{const f=await fixture();try{const b=createSandboxBackend({ctx:{},readNode:f.readNode,commitBinding:f.commitBinding,configPath:f.configPath,requestsDir:f.requestsDir,decisionPath:f.decisionPath,clock:()=>f.now,transport:f.transport});await fn(f,b);}finally{await f.cleanup();}};
test('prepare durably pins bounded original file metadata without content',()=>run(async(f,b)=>{
 await b.prepare(f.project,f.node);assert.deepEqual(f.node.sandbox.sourceFiles,[{path:'README.md',size:5,sha256:entry('README.md','hello').sha256}]);
 assert.ok(f.commits.find(c=>c.binding.operations&&Object.values(c.binding.operations).some(o=>o.action==='acquire'&&o.state==='intent')).binding.sourceFiles);
}));
test('unsupported remote deletion is rejected before any Host restore, not silently kept as successful Git result',()=>run(async(f,b)=>{
 await b.prepare(f.project,f.node);f.files.delete('README.md');f.files.set('new.txt',entry('new.txt','new'));
 await assert.rejects(()=>b.collect(f.project,f.node),e=>e.code==='SANDBOX_COLLECTION_DELETE_UNSUPPORTED');
 assert.equal(await readFile(f.worktree+'/README.md','utf8'),'hello');await assert.rejects(()=>stat(f.worktree+'/new.txt'),{code:'ENOENT'});
 assert.ok(Object.values(f.node.sandbox.operations).every(o=>o.state==='completed'),'no false remote-execution Unknown for known unsupported file semantics');
 await b.release(f.project,f.node);assert.equal(f.node.sandbox.verifiedClean,true);
}));
test('missing or malformed original manifest cannot be interpreted as no deletion',()=>run(async(f,b)=>{
 await b.prepare(f.project,f.node);for(const value of [undefined,{},[{path:'../README.md',size:5,sha256:'0'.repeat(64)}]]){
  f.node.sandbox.sourceFiles=value;await assert.rejects(()=>b.collect(f.project,f.node),e=>e.code==='SANDBOX_SOURCE_MANIFEST');
 }
}));

test('coercible hash and parent/file or parent-case collisions are malformed before any collection RPC',()=>run(async(f,b)=>{
 await b.prepare(f.project,f.node);const good={path:'README.md',size:5,sha256:entry('README.md','hello').sha256};
 for(const sourceFiles of [[{...good,sha256:[good.sha256]}],[good,{...good,path:'README.md/child'}],[{...good,path:'A/file'},{...good,path:'a/other'}]]){
  f.node.sandbox.sourceFiles=sourceFiles;const before=f.uploads.size;
  await assert.rejects(()=>b.collect(f.project,f.node),e=>e.code==='SANDBOX_SOURCE_MANIFEST');assert.equal(f.uploads.size,before);
 }
}));
