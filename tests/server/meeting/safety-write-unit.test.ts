import {snapshotSignature} from '../../../server/mcp/reschedule.js';
import {loadSchedule} from '../../../server/mcp/snapshot.js';
import {applyPlan} from '../../../server/mcp/apply-plan.js';
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openV2Database, type V2Database } from "../../../server/db/database.js";
import { migrateV2Database } from "../../../server/db/migrations.js";
import { resolveDependencies } from "../../../server/http/dependencies.js";
import type { AuthenticatedSession } from "../../../server/modules/auth/auth-service.js";
import { ProjectService } from "../../../server/modules/projects/project-service.js";
import { ScheduleService } from "../../../server/modules/schedule/schedule-service.js";
import type { AppliedPlanRecord } from "../../../server/meeting/events.js";
import { undoPlan } from "../../../server/meeting/undo.js";

function signature(runtime: any, projectId: string) { const {snapshot,context}=loadSchedule(runtime,projectId); return snapshotSignature(snapshot,context); }

const openDatabases: V2Database[] = [];
const temporaryDirectories: string[] = [];

function sessionFor(id: string, username: string, now: Date): AuthenticatedSession {
  const iso = now.toISOString();
  return {
    sessionId: "test-session",
    tokenHash: "test-session",
    teamMember: true,
    user: { id, username, displayName: username, createdAt: iso, updatedAt: iso, revision: 1 },
  };
}

function fixture() {
  const now = new Date("2026-07-17T08:00:00.000Z");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "undo-guard-"));
  temporaryDirectories.push(directory);
  const database = openV2Database(path.join(directory, "app.sqlite"));
  openDatabases.push(database);
  migrateV2Database(database, () => now.toISOString());
  const dependencies = resolveDependencies({
    database,
    sessionSecret: "undo-guard-test-secret-32-characters",
    cookieSecure: false,
    bootstrapCode: "undo-guard-bootstrap",
    clock: () => new Date(now.getTime()),
  });
  const projects = new ProjectService(dependencies);
  const schedule = new ScheduleService(dependencies);

  const leaderId = randomUUID();
  const ownerId = randomUUID();
  const otherId = randomUUID();
  for (const [id, username] of [
    [leaderId, "leader"],
    [ownerId, "owner"],
    [otherId, "other"],
  ] as const) {
    database.run(
      `INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at)
       VALUES (?, ?, 'test', ?, ?, ?)`,
      [id, username, username, now.toISOString(), now.toISOString()],
    );
    database.run(
      "INSERT INTO team_members (user_id, joined_at, invited_by) VALUES (?, ?, ?)",
      [id, now.toISOString(), leaderId],
    );
  }
  const lead = sessionFor(leaderId, "leader", now);
  const project = projects.create(lead, {
    name: "撤销保护测试",
    description: "",
    startDate: "2026-07-20",
    endDate: "2026-12-31",
    memberUserIds: [ownerId, otherId],
  });
  const task = schedule.createTask(lead, project.project.id, {
    title: "演示脚本",
    startDate: "2026-07-20",
    dueDate: "2026-07-25",
  }).task;
  const participant = schedule.addParticipant(lead, project.project.id, task.id, {
    userId: ownerId,
    startDate: "2026-07-20",
    endDate: "2026-07-25",
    estimatedMinutes: 600,
  }).participant;

  return { dependencies, schedule, lead, projectId: project.project.id, task, participant, ownerId, otherId };
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()!.close();
  while (temporaryDirectories.length > 0) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});



function runtimeFor(f: ReturnType<typeof fixture>): any {
 return {auth:f.lead,database:f.dependencies.database,schedule:f.schedule,projects:new ProjectService(f.dependencies),availability:{projectConflicts:()=>[],projectSummary:()=>({members:[]})}};
}
function snapshot(db: V2Database) {
 return Object.fromEntries(['projects','tasks','task_participants','activity_log'].map(t=>[t,db.all(`SELECT * FROM ${t} ORDER BY id`)]));
}
function splitOps(f: ReturnType<typeof fixture>): any[] { return [{kind:'split',participantId:f.participant.id,taskId:f.task.id,fromUserId:f.ownerId,toUserId:f.otherId,moveMinutes:480,newParticipantId:'child'}]; }
it('failed apply rolls back task/participant/revisions/activity and preserves prior B commit',()=>{
 const f=fixture(),db=f.dependencies.database;
 const b=openV2Database(db.get<{file:string}>('PRAGMA database_list')!.file);openDatabases.push(b);
 b.run("UPDATE tasks SET title='B saved',revision=revision+1 WHERE id=?",[f.task.id]);
 const before=snapshot(db);
 db.run("CREATE TRIGGER fail_child BEFORE INSERT ON task_participants BEGIN SELECT RAISE(ABORT, 'synthetic child failure'); END");
 expect(()=>applyPlan(runtimeFor(f),f.projectId,{operations:splitOps(f),beforeSignature:signature(runtimeFor(f),f.projectId),before:{conflicts:0}} as any)).toThrow('synthetic child failure');
 expect(snapshot(db)).toEqual(before);expect(snapshot(b)).toEqual(before);
});
it('apply holds write lock before first mutation: concurrent B cannot be lost by compensation',()=>{
 const f=fixture(),db=f.dependencies.database;
 const b=openV2Database(db.get<{file:string}>('PRAGMA database_list')!.file);openDatabases.push(b);b.exec('PRAGMA busy_timeout=0');
 const original=db.run.bind(db);let observed=false;
 db.run=(sql,...args)=>{ if(!observed && /UPDATE task_participants/.test(sql)){observed=true;expect(()=>b.run("UPDATE tasks SET title='racing B' WHERE id=?",[f.task.id])).toThrow(/locked|busy/i);}return original(sql,...args);};
 applyPlan(runtimeFor(f),f.projectId,{operations:splitOps(f),beforeSignature:signature(runtimeFor(f),f.projectId),before:{conflicts:0}} as any);
 expect(observed).toBe(true);
 b.run("UPDATE tasks SET title='B after commit' WHERE id=?",[f.task.id]);
 expect(db.get<{title:string}>('SELECT title FROM tasks WHERE id=?',[f.task.id])!.title).toBe('B after commit');
});
it('undo refuses missing receipt and revoked project access with no writes',()=>{
 const f=fixture(),db=f.dependencies.database,operations=splitOps(f);
 const applied=applyPlan(runtimeFor(f),f.projectId,{operations,beforeSignature:signature(runtimeFor(f),f.projectId),before:{conflicts:0}} as any);
 const plan:any={id:'p',label:'p',operations,createdParticipants:applied.createdParticipants,afterRevisions:applied.afterRevisions};
 let before=snapshot(db);expect(undoPlan(f.dependencies,f.lead,f.projectId,{...plan,afterRevisions:undefined}).reverted).toBe(0);expect(snapshot(db)).toEqual(before);
 db.run('UPDATE project_members SET removed_at=? WHERE project_id=? AND user_id=?',['2026-07-18',f.projectId,f.lead.user.id]);
 before=snapshot(db);expect(undoPlan(f.dependencies,f.lead,f.projectId,plan).reverted).toBe(0);expect(snapshot(db)).toEqual(before);
});

it('undo recomputes task status and preserves audit/revision side effects',()=>{
 const f=fixture(),db=f.dependencies.database;
 // Synthetic existing completed participant; split introduces an unfinished child.
 db.run("UPDATE task_participants SET status='done',progress_percent=100 WHERE id=?",[f.participant.id]);
 const runtime=runtimeFor(f),operations=splitOps(f);
 const applied=applyPlan(runtime,f.projectId,{operations,beforeSignature:signature(runtime,f.projectId),before:{conflicts:0}} as any);
 expect(f.schedule.listTasks(f.lead,f.projectId)[0]!.status).toBe('in_progress');
 const auditBefore=db.get<{n:number}>('SELECT COUNT(*) AS n FROM activity_log')!.n;
 const revisionBefore=db.get<{schedule_revision:number}>('SELECT schedule_revision FROM projects WHERE id=?',[f.projectId])!.schedule_revision;
 const result=undoPlan(f.dependencies,f.lead,f.projectId,{id:'p',label:'p',operations,createdParticipants:applied.createdParticipants,afterRevisions:applied.afterRevisions});
 expect(result.reverted).toBe(1);expect(result.skipped).toEqual([]);
 expect(f.schedule.listTasks(f.lead,f.projectId)[0]!.status).toBe('pending_review');
 expect(db.get<{n:number}>('SELECT COUNT(*) AS n FROM activity_log')!.n).toBeGreaterThan(auditBefore);
 expect(db.get<{schedule_revision:number}>('SELECT schedule_revision FROM projects WHERE id=?',[f.projectId])!.schedule_revision).toBeGreaterThan(revisionBefore);
 expect(db.all<{action:string}>('SELECT action FROM activity_log ORDER BY rowid DESC LIMIT 2').map(r=>r.action).sort()).toEqual(['participant.deleted','participant.updated']);
});

it('write facade cannot escape its transaction scope',()=>{
 const f=fixture();let escaped:any;
 f.schedule.writeUnit(f.lead,f.projectId,w=>{escaped=w;});
 const before=snapshot(f.dependencies.database);
 expect(()=>escaped.updateParticipant(f.participant.id,{expectedRevision:f.participant.revision,estimatedMinutes:30})).toThrow(/expired/);
 expect(snapshot(f.dependencies.database)).toEqual(before);
});
it('write unit rejects async results and rolls back even synchronous work before await',()=>{
 const f=fixture(),before=snapshot(f.dependencies.database);
 expect(()=>f.schedule.writeUnit(f.lead,f.projectId,w=>{
  w.updateParticipant(f.participant.id,{expectedRevision:f.participant.revision,estimatedMinutes:30});
  return Promise.resolve('not a synchronous unit');
 })).toThrow(/async|promise|synchronous|thenable/i);
 expect(snapshot(f.dependencies.database)).toEqual(before);
});
it('native async callback is rejected before it can run',()=>{
 const f=fixture(),before=snapshot(f.dependencies.database);let called=false;
 expect(()=>f.schedule.writeUnit(f.lead,f.projectId,async ()=>{called=true;})).toThrow(/async|promise|synchronous|thenable/i);
 expect(called).toBe(false);expect(snapshot(f.dependencies.database)).toEqual(before);
});
it('extend undo restores an explicitly absent task due date to null',()=>{
 const f=fixture();
 f.schedule.updateTask(f.lead,f.projectId,f.task.id,{expectedRevision:f.task.revision,dueDate:null});
 const runtime=runtimeFor(f),operations:any[]=[{kind:'extend',participantId:f.participant.id,taskId:f.task.id,newEndDate:'2026-07-28',previousEndDate:'2026-07-25',previousTaskDueDate:null}];
 const applied=applyPlan(runtime,f.projectId,{operations,beforeSignature:signature(runtime,f.projectId),before:{conflicts:0}} as any);
 const result=undoPlan(f.dependencies,f.lead,f.projectId,{id:'p',label:'p',operations,createdParticipants:applied.createdParticipants,afterRevisions:applied.afterRevisions});
 expect(result.reverted).toBe(1);expect(result.skipped).toEqual([]);
 expect(f.schedule.listTasks(f.lead,f.projectId)[0]!.dueDate).toBeNull();
 expect(f.schedule.listParticipants(f.lead,f.projectId)[0]!.endDate).toBe('2026-07-25');
});
it('legacy extend lacking previous task due date refuses rather than guessing or partially writing',()=>{
 const f=fixture(),runtime=runtimeFor(f),operations:any[]=[{kind:'extend',participantId:f.participant.id,taskId:f.task.id,newEndDate:'2026-07-28',previousEndDate:'2026-07-25'}];
 const applied=applyPlan(runtime,f.projectId,{operations,beforeSignature:signature(runtime,f.projectId),before:{conflicts:0}} as any);
 const before=snapshot(f.dependencies.database);
 const result=undoPlan(f.dependencies,f.lead,f.projectId,{id:'p',label:'p',operations,createdParticipants:applied.createdParticipants,afterRevisions:applied.afterRevisions});
 expect(result.reverted).toBe(0);expect(result.skipped).toHaveLength(1);
 expect(snapshot(f.dependencies.database)).toEqual(before);
});
