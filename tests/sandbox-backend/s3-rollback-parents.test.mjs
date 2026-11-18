import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile, rename, symlink, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { restoreWorktreeFiles } from '../../host/sandbox-files.js';
import { fixture, entry, bundle } from './fakes.mjs';
for(const existing of [true,false])for(const deep of [false,true])test('rollback retains recovery and never follows relocated '+(deep?'ancestor':'parent')+' junction '+(existing?'with backup':'without backup'),async()=>{
 const f=await fixture();try{
  const relative=deep?'nested/inner/value.txt':'nested/value.txt',original=path.join(f.worktree,'nested'),target=path.join(f.worktree,...relative.split('/')),outside=path.join(f.temp,'relocated');
  await mkdir(path.dirname(target),{recursive:true});if(existing)await writeFile(target,'host-before');
  let calls=0,error;
  try{await restoreWorktreeFiles(f.worktree,bundle([entry(relative,'remote-after')]),{guard:async()=>{if(++calls===5){await rename(original,outside);await symlink(outside,original,'junction');throw Object.assign(new Error('controlled parent junction swap after install'),{code:'CONTROLLED_CONFLICT'});}}});}catch(e){error=e;}
  assert.equal(calls,5);const relocated=path.join(outside,...relative.split('/').slice(1));
  assert.equal(await readFile(relocated,'utf8'),'remote-after','rollback must not mutate or delete the relocated external file');
  assert.equal(error?.code,'SANDBOX_RESTORE_UNKNOWN');assert.ok(error.recoveryPath);assert.equal((await lstat(error.recoveryPath)).isDirectory(),true);
  const materials=await readdir(error.recoveryPath);if(existing){assert.ok(materials.includes('0.before'));assert.equal(await readFile(path.join(error.recoveryPath,'0.before'),'utf8'),'host-before');}
  assert.equal(await readFile(path.join(error.recoveryPath,'0.after'),'utf8'),'remote-after','retain incoming recovery bytes even when there was no backup');
 }finally{await f.cleanup();}
});
test('rollback refuses replacement real directory even when the installed file inode is unchanged',async()=>{
 const f=await fixture();try{
  const nested=path.join(f.worktree,'nested'),outside=path.join(f.temp,'relocated'),target=path.join(nested,'value.txt');await mkdir(nested);await writeFile(target,'host-before');let calls=0,error;
  try{await restoreWorktreeFiles(f.worktree,bundle([entry('nested/value.txt','remote-after')]),{guard:async()=>{if(++calls===5){await rename(nested,outside);await mkdir(nested);await rename(path.join(outside,'value.txt'),target);throw Error('same inode under replaced real parent');}}});}catch(e){error=e;}
  assert.equal(error?.code,'SANDBOX_RESTORE_UNKNOWN');assert.equal(await readFile(target,'utf8'),'remote-after');assert.equal(await readFile(path.join(error.recoveryPath,'0.before'),'utf8'),'host-before');
 }finally{await f.cleanup();}
});
test('a changed first parent cannot escape checks while another installed root file safely rolls back',async()=>{
 const f=await fixture();try{
  const nested=path.join(f.worktree,'nested'),outside=path.join(f.temp,'relocated');await mkdir(nested);await writeFile(path.join(nested,'value.txt'),'host-before');let calls=0,error;
  try{await restoreWorktreeFiles(f.worktree,bundle([entry('nested/value.txt','remote-after'),entry('README.md','changed-root')]),{guard:async()=>{if(++calls===7){await rename(nested,outside);await symlink(outside,nested,'junction');throw Error('first parent moved after two installs');}}});}catch(e){error=e;}
  assert.equal(error?.code,'SANDBOX_RESTORE_UNKNOWN');assert.equal(await readFile(path.join(outside,'value.txt'),'utf8'),'remote-after');assert.equal(await readFile(path.join(f.worktree,'README.md'),'utf8'),'hello');assert.equal(await readFile(path.join(error.recoveryPath,'0.before'),'utf8'),'host-before');
 }finally{await f.cleanup();}
});

test('final scope guard cannot make a parent swap look like a successful collection',async()=>{
 const f=await fixture();try{
  const nested=path.join(f.worktree,'nested'),outside=path.join(f.temp,'relocated');await mkdir(nested);await writeFile(path.join(nested,'value.txt'),'host-before');let calls=0,error;
  try{await restoreWorktreeFiles(f.worktree,bundle([entry('nested/value.txt','remote-after')]),{guard:async()=>{if(++calls===6){await rename(nested,outside);await symlink(outside,nested,'junction');}}});}catch(e){error=e;}
  assert.equal(error?.code,'SANDBOX_RESTORE_UNKNOWN');assert.equal(await readFile(path.join(outside,'value.txt'),'utf8'),'remote-after');assert.equal(await readFile(path.join(error.recoveryPath,'0.before'),'utf8'),'host-before');
 }finally{await f.cleanup();}
});
test('a replaced private recovery directory never supplies bytes to rollback or gets removed',async()=>{
 const f=await fixture();try{
  let calls=0,error,original,moved=path.join(f.temp,'relocated-stage');
  try{await restoreWorktreeFiles(f.worktree,bundle([entry('README.md','remote-after')]),{guard:async()=>{if(++calls===5){const names=(await readdir(f.project.repo.worktreeRoot)).filter(n=>n.startsWith('.sandbox-v2-'));assert.equal(names.length,1);original=path.join(f.project.repo.worktreeRoot,names[0]);await rename(original,moved);await symlink(moved,original,'junction');throw Error('private stage moved');}}});}catch(e){error=e;}
  assert.equal(error?.code,'SANDBOX_RESTORE_UNKNOWN');assert.equal(error.recoveryPath,original);assert.equal(await readFile(path.join(f.worktree,'README.md'),'utf8'),'remote-after');assert.equal(await readFile(path.join(moved,'0.before'),'utf8'),'hello');assert.equal(await readFile(path.join(moved,'0.after'),'utf8'),'remote-after');assert.equal((await lstat(original)).isSymbolicLink(),true);
 }finally{await f.cleanup();}
});

test('a later pending parent change remains Unknown even when earlier safe files roll back',async()=>{
 const f=await fixture();try{
  const nested=path.join(f.worktree,'nested'),outside=path.join(f.temp,'relocated');await mkdir(nested);await writeFile(path.join(nested,'value.txt'),'host-before');let calls=0,error;
  try{await restoreWorktreeFiles(f.worktree,bundle([entry('README.md','remote-root'),entry('nested/value.txt','remote-later')]),{guard:async()=>{if(++calls===5){await rename(nested,outside);await symlink(outside,nested,'junction');}}});}catch(e){error=e;}
  assert.equal(error?.code,'SANDBOX_RESTORE_UNKNOWN');assert.equal(await readFile(path.join(outside,'value.txt'),'utf8'),'host-before');assert.equal(await readFile(path.join(f.worktree,'README.md'),'utf8'),'hello');assert.equal(await readFile(path.join(error.recoveryPath,'1.before'),'utf8'),'host-before');assert.equal(await readFile(path.join(error.recoveryPath,'1.after'),'utf8'),'remote-later');
 }finally{await f.cleanup();}
});
