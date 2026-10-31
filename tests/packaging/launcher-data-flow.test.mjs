import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'launcher-flow-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,programRoot:path.join(root,'program'),exeDir:path.join(root,'exe'),home:path.join(root,'home'),temporaryRoot:path.join(root,'temp')};
}
function error(code) { return Object.assign(new Error(`synthetic ${code}`),{code}); }
function seed(root,label='synthetic task') {
  fs.mkdirSync(path.join(root,'data'),{recursive:true});
  const db=new DatabaseSync(path.join(root,'data','app.sqlite'));
  db.exec('CREATE TABLE tasks(title TEXT)');db.prepare('INSERT INTO tasks VALUES(?)').run(label);db.close();
  fs.mkdirSync(path.join(root,'data','llm'),{recursive:true});
  fs.writeFileSync(path.join(root,'data','llm','synthetic.json'),'{"key":"synthetic-only"}');
  fs.mkdirSync(path.join(root,'data','uploads'),{recursive:true});
  fs.writeFileSync(path.join(root,'data','uploads','synthetic.txt'),'synthetic upload');
  fs.writeFileSync(path.join(root,'config.json'),'{"sessionSecret":"synthetic-only"}');
}
function taskTitle(root) {
  const db=new DatabaseSync(path.join(root,'data','app.sqlite'),{readOnly:true});
  try{return db.prepare('SELECT title FROM tasks').get().title;}finally{db.close();}
}
import { pathState, readPointer, writePointer, resolveDataDirectory } from '../../packaging/launcher/launcher-data-flow.mjs';
function options(f,extra={}) {
 fs.mkdirSync(f.exeDir,{recursive:true});
 return {programRoot:f.programRoot,env:{TODOLIST_EXE_DIR:f.exeDir,LOCALAPPDATA:path.join(f.root,'local')},platform:'win32',home:f.home,findLegacy:()=>[],log:()=>{},...extra};
}
function deniedPointerIO(f) {
 const pointer=path.join(f.exeDir,'todolist-data-root.txt');
 return {...fs,lstatSync(p){if(p===pointer)throw error('EACCES');return fs.lstatSync(p);}};
}
test('unknown pointer is not absence and prevents default picker or UI',async t=>{
 const f=fixture(t);let picked=0,asked=0;
 await assert.rejects(resolveDataDirectory(options(f,{io:deniedPointerIO(f),pick:()=>{picked++;},ask:async()=>{asked++;return 'YES'},isInteractive:true})),/指针/);
 assert.equal(picked,0);assert.equal(asked,0);
});
for(const value of ['', 'relative']) test(`invalid pointer ${JSON.stringify(value)} fails closed`,async t=>{
 const f=fixture(t),opts=options(f);fs.writeFileSync(path.join(f.exeDir,'todolist-data-root.txt'),value);let picked=0;
 await assert.rejects(resolveDataDirectory({...opts,pick:()=>{picked++;}}),/指针/);assert.equal(picked,0);
});
test('known saved pointer cannot fall back if its selected directory fails',async t=>{
 const f=fixture(t),opts=options(f),saved=path.join(f.root,'saved');fs.writeFileSync(path.join(f.exeDir,'todolist-data-root.txt'),saved);let count=0;
 await assert.rejects(resolveDataDirectory({...opts,pick:({env})=>{count++;assert.equal(env.TODOLIST_DATA_ROOT,saved);throw error('EPERM')}}),/EPERM/);assert.equal(count,1);
});
test('pointer storage never overwrites an existing choice and rejects write denial',t=>{
 const f=fixture(t),p=path.join(f.root,'pointer'),value=path.join(f.root,'one');writePointer(p,value);writePointer(p,value);
 assert.throws(()=>writePointer(p,path.join(f.root,'two')),/无法安全保存/);assert.equal(fs.readFileSync(p,'utf8'),value);
 assert.throws(()=>writePointer('unused',value,{writeFileSync(){throw error('EPERM')}}),/无法安全保存/);
});
for(const failure of ['EPERM','EACCES','migration lock']) test(`explicit data root ${failure} never falls back`,async t=>{
 const f=fixture(t),opts=options(f);let count=0,asked=0;
 await assert.rejects(resolveDataDirectory({...opts,env:{...opts.env,TODOLIST_DATA_ROOT:path.join(f.root,'explicit')},pick:()=>{count++;throw error(failure)},isInteractive:true,ask:async()=>{asked++;return 'YES'}}));
 assert.equal(count,1);assert.equal(asked,0);assert.equal(fs.existsSync(path.join(f.exeDir,'todolist-data-root.txt')),false);
});
test('default inaccessible existing or unknown directory cannot authorize fallback',async t=>{
 for(const state of ['exists','unknown']) {
 const f=fixture(t),opts=options(f),def=path.join(opts.env.LOCALAPPDATA,'ToDoList');let asked=0,count=0;
 if(state==='exists')fs.mkdirSync(def,{recursive:true});
 const io={...fs,lstatSync(p){if(p===def&&state==='unknown')throw error('EACCES');return fs.lstatSync(p)}};
 await assert.rejects(resolveDataDirectory({...opts,io,pick:()=>{count++;throw error('EPERM')},isInteractive:true,ask:async()=>{asked++;return 'YES'}}),/默认数据目录/);
 assert.equal(count,1);assert.equal(asked,0);
 }
});
for(const mode of ['cancel','noninteractive']) test(`${mode}: no fallback database or pointer created`,async t=>{
 const f=fixture(t),opts=options(f);let count=0;
 await assert.rejects(resolveDataDirectory({...opts,pick:({env})=>{count++;if(!env.TODOLIST_DATA_ROOT)throw error('EPERM');throw new Error('should not select')},isInteractive:mode==='cancel',ask:async()=> 'NO'}));
 assert.equal(count,1);assert.equal(fs.existsSync(path.join(f.exeDir,'ToDoList-data')),false);assert.equal(fs.existsSync(path.join(f.exeDir,'todolist-data-root.txt')),false);
});
test('fallback YES is persisted and later default permission changes cannot switch it',async t=>{
 const f=fixture(t),opts=options(f),fallback=path.join(f.exeDir,'ToDoList-data');let calls=[];
 const pick=({env})=>{calls.push(env.TODOLIST_DATA_ROOT);if(!env.TODOLIST_DATA_ROOT)throw error('EPERM');fs.mkdirSync(env.TODOLIST_DATA_ROOT,{recursive:true});return env.TODOLIST_DATA_ROOT;};
 assert.equal(await resolveDataDirectory({...opts,pick,isInteractive:true,ask:async()=> 'YES'}),fallback);
 calls=[];assert.equal(await resolveDataDirectory({...opts,pick}),fallback);assert.deepEqual(calls,[fallback]);
});
test('pointer persistence failure prevents successful startup result',async t=>{
 const f=fixture(t),opts=options(f),pointer=path.join(f.exeDir,'todolist-data-root.txt');
 const io={...fs,writeFileSync(p,...args){if(p===pointer)throw error('EROFS');return fs.writeFileSync(p,...args)}};
 await assert.rejects(resolveDataDirectory({...opts,io,pick:({env})=>{if(!env.TODOLIST_DATA_ROOT)throw error('EPERM');return env.TODOLIST_DATA_ROOT},isInteractive:true,ask:async()=> 'YES'}),/无法安全保存/);
});
test('multiple legacy roots require explicit choice and offline confirmation; chosen SQLite copied intact',async t=>{
 const f=fixture(t),a=path.join(f.root,'old-a'),b=path.join(f.root,'old-b'),destination=path.join(f.root,'new');seed(a,'A');seed(b,'B');let prompts=[];let answers=['2','MIGRATE'];
 const result=await resolveDataDirectory(options(f,{pick:()=>destination,findLegacy:()=>[a,b],isInteractive:true,ask:async q=>{prompts.push(q);return answers.shift();}}));
 assert.equal(fs.readFileSync(path.join(destination,'data/uploads/synthetic.txt'),'utf8'),'synthetic upload');
 assert.equal(result,destination);assert.equal(taskTitle(destination),'B');assert.equal(taskTitle(a),'A');assert.equal(taskTitle(b),'B');assert.equal(prompts.length,2);
 assert.equal(fs.readFileSync(path.join(destination,'config.json'),'utf8'),fs.readFileSync(path.join(b,'config.json'),'utf8'));
 assert.equal(fs.readFileSync(path.join(destination,'data/llm/synthetic.json'),'utf8'),fs.readFileSync(path.join(b,'data/llm/synthetic.json'),'utf8'));
});
for(const answers of [['0'],['2','NO']]) test(`migration cancellation ${answers.join('/')} preserves both sources and no destination`,async t=>{
 const f=fixture(t),a=path.join(f.root,'old-a'),b=path.join(f.root,'old-b'),destination=path.join(f.root,'new');seed(a,'A');seed(b,'B');const queue=[...answers];
 await assert.rejects(resolveDataDirectory(options(f,{pick:()=>destination,findLegacy:()=>[a,b],isInteractive:true,ask:async()=>queue.shift()})),/取消/);
 assert.equal(fs.existsSync(destination),false);assert.equal(taskTitle(a),'A');assert.equal(taskTitle(b),'B');
});
test('migration cancellation after fallback confirmation does not save pointer or create database',async t=>{
 const f=fixture(t),a=path.join(f.root,'old');seed(a);const opts=options(f),answers=['YES','0'];
 await assert.rejects(resolveDataDirectory({...opts,pick:({env})=>{if(!env.TODOLIST_DATA_ROOT)throw error('EPERM');return env.TODOLIST_DATA_ROOT},findLegacy:()=>[a],isInteractive:true,ask:async()=>answers.shift()}),/取消/);
 assert.equal(fs.existsSync(path.join(f.exeDir,'todolist-data-root.txt')),false);assert.equal(fs.existsSync(path.join(f.exeDir,'ToDoList-data','data','app.sqlite')),false);assert.equal(taskTitle(a),'synthetic task');
});
for(const kind of ['existing destination','WAL']) test(`migration rejects ${kind} without overwriting or deleting source`,async t=>{
 const f=fixture(t),source=path.join(f.root,'old'),destination=path.join(f.root,'new');seed(source,'old');
 if(kind==='WAL')fs.writeFileSync(path.join(source,'data','app.sqlite-wal'),'synthetic pending WAL');else seed(destination,'new');
 const before=fs.readFileSync(path.join(source,'data','app.sqlite'));let answers=['1','MIGRATE'];
 await assert.rejects(resolveDataDirectory(options(f,{pick:()=>destination,findLegacy:()=>[source],isInteractive:true,ask:async()=>answers.shift()})),/contains data|Stop the old/);
 assert.deepEqual(fs.readFileSync(path.join(source,'data','app.sqlite')),before);
 if(kind==='existing destination')assert.equal(taskTitle(destination),'new');else assert.equal(fs.existsSync(destination),false);
});

test('real explicit relative configuration and migration lock fail without fallback',async t=>{
 const f=fixture(t),opts=options(f);let asked=0;
 await assert.rejects(resolveDataDirectory({...opts,env:{...opts.env,TODOLIST_DATA_ROOT:'relative'},isInteractive:true,ask:async()=>{asked++;return 'YES'}}),/absolute/);
 const selected=path.join(f.root,'selected');fs.writeFileSync(selected+'.migration-lock','synthetic lock');
 await assert.rejects(resolveDataDirectory({...opts,env:{...opts.env,TODOLIST_DATA_ROOT:selected},isInteractive:true,ask:async()=>{asked++;return 'YES'}}),/migration|迁移/i);
 assert.equal(asked,0);assert.equal(fs.existsSync(path.join(f.exeDir,'ToDoList-data')),false);
});
test('live DELETE-journal writer blocks migration without publishing or losing committed records',async t=>{
 const f=fixture(t),source=path.join(f.root,'old'),destination=path.join(f.root,'new');seed(source,'committed');
 const db=new DatabaseSync(path.join(source,'data','app.sqlite'));db.exec("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE");
 const answers=['1','MIGRATE'];
 try {
  await assert.rejects(resolveDataDirectory(options(f,{pick:()=>destination,findLegacy:()=>[source],isInteractive:true,ask:async()=>answers.shift()})),/locked|busy/i);
  assert.equal(fs.existsSync(destination),false);assert.equal(db.prepare('SELECT title FROM tasks').get().title,'committed');
 } finally {db.exec('ROLLBACK');db.close();}
 assert.equal(taskTitle(source),'committed');
});
test('cleanly closed WAL database migrates without copying transient connection sidecars',async t=>{
 const f=fixture(t),source=path.join(f.root,'old'),destination=path.join(f.root,'new');seed(source,'WAL committed');
 const db=new DatabaseSync(path.join(source,'data','app.sqlite'));db.exec('PRAGMA journal_mode=WAL');db.close();
 assert.equal(fs.existsSync(path.join(source,'data','app.sqlite-wal')),false);
 const answers=['1','MIGRATE'];
 const result=await resolveDataDirectory(options(f,{pick:()=>destination,findLegacy:()=>[source],isInteractive:true,ask:async()=>answers.shift()}));
 assert.equal(result,destination);assert.equal(taskTitle(destination),'WAL committed');assert.equal(taskTitle(source),'WAL committed');
});
