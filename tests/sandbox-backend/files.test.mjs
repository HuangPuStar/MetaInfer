import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile, symlink, readdir, link } from 'node:fs/promises';
import path from 'node:path';
import { validateRelativePath, validateFileManifest, readWorktreeFiles, restoreWorktreeFiles } from '../../host/sandbox-files.js';
import { fixture, entry, bundle, clone } from './fakes.mjs';
test('portable paths reject escape, private metadata, Windows aliases and ambiguity',()=>{
  assert.equal(validateRelativePath('src/a.txt'),'src/a.txt');
  for(const p of ['../x','/x','a//b','a/./b','C:/x','a\\b','.GIT/config','.env','x/id_rsa','secret.key','CON.txt','foo.','a/../b','a\u0000b','a\u007fb','x:stream']) assert.throws(()=>validateRelativePath(p),p);
});
test('manifest verifies strict base64/hash/size/count/total/case and truncation',()=>{
  const good=bundle([entry('a.bin',Buffer.from([0,255,10]))]);assert.equal(validateFileManifest(good)[0].content.length,3);
  const bads=[{...good,truncated:true},{...good,totalBytes:999},bundle([entry('A','x'),entry('a','y')]),bundle(Array.from({length:129},(_,i)=>entry('f'+i,'')))];
  for(const patch of [{contentBase64:'YQ'},{contentBase64:'YR=='},{contentBase64:'YQ==\n'},{sha256:'0'.repeat(64)},{size:true},{path:'.git/config'},{type:'symlink'}]){const b=clone(good);Object.assign(b.files[0],patch);bads.push(b);}
  for(const bad of bads)assert.throws(()=>validateFileManifest(bad));
});
test('worktree snapshot excludes git metadata but rejects symlinks and hardlink ambiguity',async()=>{
  const f=await fixture();try{
    await writeFile(path.join(f.worktree,'.git'),'private git path');
    const files=await readWorktreeFiles(f.worktree);assert.deepEqual(files.map(e=>e.path),['README.md']);
    await symlink(path.join(f.temp,'outside'),path.join(f.worktree,'link'),'junction');
    await assert.rejects(()=>readWorktreeFiles(f.worktree));
  }finally{await f.cleanup();}
});
test('atomic restoration validates whole bundle before touching existing files',async()=>{
  const f=await fixture();try{
    const bad=bundle([entry('README.md','new'),{...entry('b','x'),sha256:'0'.repeat(64)}]);
    await assert.rejects(()=>restoreWorktreeFiles(f.worktree,bad));assert.equal(await readFile(path.join(f.worktree,'README.md'),'utf8'),'hello');
    const result=await restoreWorktreeFiles(f.worktree,bundle([entry('README.md','new'),entry('nested/a.bin',Buffer.from([0,255]))]));
    assert.equal(result.totalBytes,5);assert.equal(await readFile(path.join(f.worktree,'README.md'),'utf8'),'new');
    assert.deepEqual(await readFile(path.join(f.worktree,'nested/a.bin')),Buffer.from([0,255]));
  }finally{await f.cleanup();}
});
test('scope/cancel failure rolls back the whole local restoration',async()=>{
  const f=await fixture();try{
    let n=0;await assert.rejects(()=>restoreWorktreeFiles(f.worktree,bundle([entry('README.md','new'),entry('second','x')]),{guard:async()=>{if(++n===5)throw Error('cancelled scope');}}));
    assert.equal(await readFile(path.join(f.worktree,'README.md'),'utf8'),'hello');
    assert.deepEqual((await readdir(f.worktree)).sort(),['README.md']);
  }finally{await f.cleanup();}
});

test('actual hardlinks are rejected before a Host workspace byte is staged',async()=>{
 const f=await fixture();try{await link(path.join(f.worktree,'README.md'),path.join(f.worktree,'linked'));await assert.rejects(()=>readWorktreeFiles(f.worktree));}finally{await f.cleanup();}
});
test('actual over-count and over-16MiB worktrees fail the bounded snapshot',async()=>{
 const f=await fixture();try{
  for(let i=0;i<129;i++)await writeFile(path.join(f.worktree,'f'+i),'');await assert.rejects(()=>readWorktreeFiles(f.worktree));
 }finally{await f.cleanup();}
 const g=await fixture();try{await writeFile(path.join(g.worktree,'large.bin'),Buffer.alloc(16*1024**2+1));await assert.rejects(()=>readWorktreeFiles(g.worktree));}finally{await g.cleanup();}
});
test('restore refuses a symlink/junction parent without touching its external target',async()=>{
 const f=await fixture();try{const outside=path.join(f.temp,'outside');await mkdir(outside);await symlink(outside,path.join(f.worktree,'redirect'),'junction');await assert.rejects(()=>restoreWorktreeFiles(f.worktree,bundle([entry('redirect/x','no')])));assert.deepEqual(await readdir(outside),[]);}finally{await f.cleanup();}
});
test('conflicting rollback retains private recovery bytes and never overwrites a concurrent edit',async()=>{
 const f=await fixture();try{
  let n=0,error;try{await restoreWorktreeFiles(f.worktree,bundle([entry('README.md','new')]),{guard:async()=>{if(++n===5){await writeFile(path.join(f.worktree,'README.md'),'concurrent');throw Error('scope changed after install');}}});}catch(e){error=e;}
  assert.equal(error?.code,'SANDBOX_RESTORE_UNKNOWN');assert.equal(await readFile(path.join(f.worktree,'README.md'),'utf8'),'concurrent');assert.ok((await readdir(error.recoveryPath)).includes('0.before'));
 }finally{await f.cleanup();}
});

test('portable validator rejects superscript COM/LPT DOS basenames without opening a device',()=>{
 for(const p of ['COM10.txt','LPT10','comparison.txt','文档/结果.txt'])assert.doesNotThrow(()=>validateRelativePath(p));
 for(const p of ['COM¹','com²','LPT³','lpt¹','COM².txt','LPT¹.log','COM³.more.txt','folder/COM¹/file','folder/LPT².txt'])assert.throws(()=>validateRelativePath(p));
});
test('portable validator rejects CONIN$/CONOUT$ aliases without opening a console',()=>{
 for(const p of ['CONINx','CONOUTx','contents.txt'])assert.doesNotThrow(()=>validateRelativePath(p));
 for(const p of ['CONIN$','CONOUT$','conin$.txt','folder/ConOut$/f'])assert.throws(()=>validateRelativePath(p));
});
