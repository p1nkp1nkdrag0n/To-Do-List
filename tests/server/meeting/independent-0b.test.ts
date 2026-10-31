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


it('independent: B commits after apply; undo refuses to overwrite',()=>{
 const f=fixture();const db=f.dependencies.database;const other=openV2Database(db.get<{file:string}>('PRAGMA database_list')!.file);openDatabases.push(other);

 const runtime:any={auth:f.lead,database:db,schedule:f.schedule,projects:new ProjectService(f.dependencies),availability:{projectConflicts:()=>[],projectSummary:()=>({members:[]})}};
 const operations:any=[{kind:'split',participantId:f.participant.id,taskId:f.task.id,fromUserId:f.ownerId,toUserId:f.otherId,moveMinutes:480,newParticipantId:'new'}];
 const applied=applyPlan(runtime,f.projectId,{operations,beforeSignature:signature(runtime,f.projectId),before:{conflicts:0}} as any);
 other.run('UPDATE task_participants SET estimated_minutes=30,revision=revision+1 WHERE id=?',[f.participant.id]);
 const result=undoPlan(f.dependencies,f.lead,f.projectId,{id:'p',label:'p',operations,createdParticipants:applied.createdParticipants,afterRevisions:applied.afterRevisions});
 expect(result.reverted).toBe(0);expect(f.schedule.listParticipants(f.lead,f.projectId).find(p=>p.id===f.participant.id)!.estimatedMinutes).toBe(30);
});
it('independent: repeated operations on same row undo successfully',()=>{
 const f=fixture();const one=f.schedule.updateParticipant(f.lead,f.projectId,f.participant.id,{expectedRevision:f.participant.revision,userId:f.otherId}).participant;
 const two=f.schedule.updateParticipant(f.lead,f.projectId,one.id,{expectedRevision:one.revision,userId:f.lead.user.id}).participant;
 const plan:any={id:'p',label:'p',operations:[{kind:'reassign',taskId:f.task.id,participantId:one.id,fromUserId:f.ownerId,toUserId:f.otherId},{kind:'reassign',taskId:f.task.id,participantId:one.id,fromUserId:f.otherId,toUserId:f.lead.user.id}],afterRevisions:{tasks:{[f.task.id]:f.schedule.listTasks(f.lead,f.projectId)[0]!.revision},participants:{[one.id]:two.revision}}};
 const result=undoPlan(f.dependencies,f.lead,f.projectId,plan);expect(result.reverted).toBe(2);expect(result.skipped).toEqual([]);expect(f.schedule.listParticipants(f.lead,f.projectId)[0]!.userId).toBe(f.ownerId);
});
  it("independent: failed second inverse write rolls back earlier remove", () => {
    const f = fixture();
    const source = f.schedule.updateParticipant(f.lead, f.projectId, f.participant.id, {
      expectedRevision: f.participant.revision,
      estimatedMinutes: 120,
    }).participant;
    const created = f.schedule.addParticipant(f.lead, f.projectId, f.task.id, {
      userId: f.otherId,
      startDate: "2026-07-20",
      endDate: "2026-07-25",
      estimatedMinutes: 480,
    }).participant;
    const plan: AppliedPlanRecord = {
      id: "plan-2",
      label: "拆分",
      operations: [
        {
          kind: "split",
          participantId: f.participant.id,
          taskId: f.task.id,
          fromUserId: f.ownerId,
          toUserId: f.otherId,
          moveMinutes: 480,
          newParticipantId: "placeholder-1",
        },
      ],
      createdParticipants: [
        {
          placeholderId: "placeholder-1",
          realId: created.id,
          taskId: f.task.id,
          userId: f.otherId,
        },
      ],
      afterRevisions: {
        tasks: { [f.task.id]: f.schedule.listTasks(f.lead, f.projectId)[0]!.revision },
        participants: {
          [source.id]: source.revision,
          [created.id]: created.revision,
        },
      },
    };

    const db=f.dependencies.database;
    const snapshot=()=>Object.fromEntries(['projects','tasks','task_participants','activity_log'].map(t=>[t,db.all(`SELECT * FROM ${t} ORDER BY id`)]));
    const before=snapshot();
    db.run(`CREATE TRIGGER fail_inverse BEFORE UPDATE ON task_participants WHEN NEW.id='${source.id}' AND NEW.estimated_minutes > OLD.estimated_minutes BEGIN SELECT RAISE(ABORT, 'synthetic inverse write failure'); END`);
    const result=undoPlan(f.dependencies,f.lead,f.projectId,plan);
    expect(result.reverted).toBe(0);expect(result.skipped[0]).toContain('synthetic');
    expect(snapshot()).toEqual(before);
  });

it('independent: undo restores assignment to member removed from project',()=>{
 const f=fixture();const updated=f.schedule.updateParticipant(f.lead,f.projectId,f.participant.id,{expectedRevision:f.participant.revision,userId:f.otherId}).participant;
 f.dependencies.database.run('UPDATE project_members SET removed_at=? WHERE project_id=? AND user_id=?',[new Date().toISOString(),f.projectId,f.ownerId]);
 const result=undoPlan(f.dependencies,f.lead,f.projectId,{id:'p',label:'p',operations:[{kind:'reassign',taskId:f.task.id,participantId:updated.id,fromUserId:f.ownerId,toUserId:f.otherId}],afterRevisions:{tasks:{},participants:{[updated.id]:updated.revision}}});
 expect(result.reverted).toBe(0);expect(f.schedule.listParticipants(f.lead,f.projectId)[0]!.userId).toBe(f.otherId);
});

it('independent: actual split then extend placeholder undoes both actions',()=>{
 const f=fixture();const runtime:any={auth:f.lead,database:f.dependencies.database,schedule:f.schedule,projects:new ProjectService(f.dependencies),availability:{projectConflicts:()=>[],projectSummary:()=>({members:[]})}};
 const operations:any=[{kind:'split',participantId:f.participant.id,taskId:f.task.id,fromUserId:f.ownerId,toUserId:f.otherId,moveMinutes:480,newParticipantId:'placeholder-child'},{kind:'extend',participantId:'placeholder-child',taskId:f.task.id,newEndDate:'2026-07-27',previousEndDate:'2026-07-25',previousTaskDueDate:'2026-07-25'}];
 const applied=applyPlan(runtime,f.projectId,{operations,beforeSignature:signature(runtime,f.projectId),before:{conflicts:0}} as any);
 const result=undoPlan(f.dependencies,f.lead,f.projectId,{id:'p',label:'p',operations,createdParticipants:applied.createdParticipants,afterRevisions:applied.afterRevisions});
 expect(result.reverted).toBe(2);expect(result.skipped).toEqual([]);expect(f.schedule.listParticipants(f.lead,f.projectId)).toHaveLength(1);expect(f.schedule.listParticipants(f.lead,f.projectId)[0]!.estimatedMinutes).toBe(600);
});
it('independent: resolved split-child then extend undoes both actions',()=>{
 const f=fixture();const runtime:any={auth:f.lead,database:f.dependencies.database,schedule:f.schedule,projects:new ProjectService(f.dependencies),availability:{projectConflicts:()=>[],projectSummary:()=>({members:[]})}};
 const operations:any=[{kind:'split',participantId:f.participant.id,taskId:f.task.id,fromUserId:f.ownerId,toUserId:f.otherId,moveMinutes:480,newParticipantId:'placeholder-child'},{kind:'extend',participantId:'placeholder-child',taskId:f.task.id,newEndDate:'2026-07-27',previousEndDate:'2026-07-25',previousTaskDueDate:'2026-07-25'}];
 const applied=applyPlan(runtime,f.projectId,{operations,beforeSignature:signature(runtime,f.projectId),before:{conflicts:0}} as any);
 operations[1].participantId=applied.createdParticipants[0]!.realId;
 const result=undoPlan(f.dependencies,f.lead,f.projectId,{id:'p',label:'p',operations,createdParticipants:applied.createdParticipants,afterRevisions:applied.afterRevisions});
 expect(result.reverted).toBe(2);expect(result.skipped).toEqual([]);expect(f.schedule.listParticipants(f.lead,f.projectId)).toHaveLength(1);expect(f.schedule.listParticipants(f.lead,f.projectId)[0]!.estimatedMinutes).toBe(600);
});
