import { describe, expect, it, vi } from 'vitest';
import { MeetingOrchestrator, type OrchestratorOptions } from '../../../server/meeting/orchestrator.js';

function harness(tasks: NonNullable<OrchestratorOptions['confirmedTasks']>) {
  const orchestrator = new MeetingOrchestrator({projectId:'project', confirmedTasks:tasks, paceMs:0});
  // Stub the transport boundary: no MCP subprocess, real model, network or data writes.
  const internal = orchestrator as unknown as {
    withClient: (run: (client: unknown) => Promise<unknown>) => Promise<unknown>;
    callTool: (...args: unknown[]) => Promise<unknown>;
    resolveConflicts: () => Promise<unknown>;
  };
  internal.withClient = run => run({});
  const call = vi.fn(async (_client: unknown, name: unknown, _args?: unknown) => name === 'list_members'
    ? {ok:true,payload:{members:[]},summary:''}
    : {ok:true,payload:{taskIds:['a','b'],count:2},summary:''});
  internal.callTool = call;
  internal.resolveConflicts = async () => ({conflictsBefore:0,conflictsAfter:0,appliedPlanId:null});
  return {orchestrator, call};
}
const task = (title:string, extra: Record<string, unknown> = {}) => ({title,ownerName:"未分配",ownerUserId:null,estimatedHours:1,dueDate:null,dependsOnTitle:null,...extra});

describe('meeting dependency confirmation before atomic submit', () => {
  it('rejects even one fuzzy substring match without calling replace_schedule', async () => {
    const h = harness([task('API 实现'), task('测试', {dependsOnTitle:'API'})]);
    await expect(h.orchestrator.runFromMinutes('')).rejects.toThrow(/精确匹配/);
    expect(h.call.mock.calls.map(c => c[1])).toEqual(['list_members']);
  });
  it('rejects ambiguous exact titles before any write', async () => {
    const h = harness([task('API'),task('API'),task('测试',{dependsOnTitle:'API'})]);
    await expect(h.orchestrator.runFromMinutes('')).rejects.toThrow(/多个任务/);
    expect(h.call.mock.calls.map(c => c[1])).toEqual(['list_members']);
  });
  it('maps an exact unique title to its stable client ID', async () => {
    const h = harness([task('API',{clientTaskId:'chosen'}),task('测试',{dependsOnTitle:'API'})]);
    await h.orchestrator.runFromMinutes('');
    const args = h.call.mock.calls.find(c => c[1] === 'replace_schedule') as unknown as [unknown,unknown,{tasks:Array<{predecessorClientTaskIds:string[]}>}];
    expect(args[2].tasks[1]!.predecessorClientTaskIds).toEqual(['chosen']);
  });
  it('allows explicit client ID to disambiguate duplicate titles', async () => {
    const h = harness([task('API',{clientTaskId:'a'}),task('API',{clientTaskId:'b'}),task('测试',{predecessorClientTaskIds:['b'],dependsOnTitle:'API'})]);
    await h.orchestrator.runFromMinutes('');
    const args = h.call.mock.calls.find(c => c[1] === 'replace_schedule') as unknown as [unknown,unknown,{tasks:Array<{predecessorClientTaskIds:string[]}>}];
    expect(args[2].tasks[2]!.predecessorClientTaskIds).toEqual(['b']);
  });
});
