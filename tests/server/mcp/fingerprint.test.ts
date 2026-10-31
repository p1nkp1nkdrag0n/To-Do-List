import { describe, expect, it } from "vitest";
import { snapshotSignature, type PlanContext, type ScheduleSnapshot } from "../../../server/mcp/reschedule.js";

function fixture(): { snapshot: ScheduleSnapshot; context: PlanContext } {
  return {
    snapshot: {
      scheduleRevision: 7,
      tasks: [{ id: 't', startDate: '2026-10-31', dueDate: '2026-11-02' }],
      participants: [{ id: 'p', taskId: 't', userId: 'u', startDate: '2026-10-31', endDate: '2026-11-02', estimatedMinutes: 600, progressPercent: 0 }],
      dependencies: [{ id: 'd', predecessorTaskId: 't', successorTaskId: 't2' }],
      profiles: [{ id: 'a', userId: 'u', validFrom: '2026-10-01', validThrough: '2026-12-01', weeklyCapacityMinutes: 600,
        weeklySlots: [{ dayOfWeek: 1, startMinute: 540, endMinute: 600 }],
        exceptions: [{ exceptionDate: '2026-11-01', kind: 'unavailable', startMinute: 540, endMinute: 600 }] }],
    },
    context: { today: '2026-10-31', timezone: 'Asia/Shanghai', projectEndDate: '2026-12-31', memberIds: ['u', 'v'], memberNames: new Map([['u', 'U'], ['v', 'V']]), taskTitles: new Map([['t', 'T']]) },
  };
}

describe('versioned complete planning fingerprint', () => {
  it('uses a bounded, versioned SHA-256 digest', () => {
    const {snapshot, context} = fixture();
    expect(snapshotSignature(snapshot, context)).toMatch(/^schedule-v2:[a-f0-9]{64}$/);
  });
  const changes: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ['dependency', f => { f.snapshot.dependencies[0]!.successorTaskId = 'other'; }],
    ['progress', f => { f.snapshot.participants[0]!.progressPercent = 50; }],
    ['task binding', f => { f.snapshot.participants[0]!.taskId = 'other'; }],
    ['weekly capacity', f => { f.snapshot.profiles[0]!.weeklyCapacityMinutes++; }],
    ['weekly slot', f => { f.snapshot.profiles[0]!.weeklySlots[0]!.endMinute++; }],
    ['exception', f => { f.snapshot.profiles[0]!.exceptions[0]!.kind = 'available'; }],
    ['profile validity', f => { f.snapshot.profiles[0]!.validThrough = '2027-01-01'; }],
    ['member set', f => { f.context.memberIds.push('new'); }],
    ['local day', f => { f.context.today = '2026-11-01'; }],
    ['timezone', f => { f.context.timezone = 'UTC'; }],
    ['project deadline', f => { f.context.projectEndDate = '2027-01-01'; }],
    ['revision / ABA', f => { f.snapshot.scheduleRevision!++; }],
    ['task title', f => { f.context.taskTitles.set('t', 'renamed'); }],
  ];
  it.each(changes)('invalidates on %s even if conflict count stays equal', (_, mutate) => {
    const f = fixture(); const before = snapshotSignature(f.snapshot, f.context);
    mutate(f); expect(snapshotSignature(f.snapshot, f.context)).not.toBe(before);
  });
  it('is stable under object property and collection ordering', () => {
    const f = fixture(); f.snapshot.tasks.push({id:'t2',dueDate:null,startDate:null});
    const before = snapshotSignature(f.snapshot, f.context);
    f.snapshot.tasks.reverse(); f.context.memberIds.reverse();
    f.context.memberNames = new Map([...f.context.memberNames].reverse());
    f.snapshot.participants = f.snapshot.participants.map(p => Object.fromEntries(Object.entries(p).reverse()) as typeof p);
    expect(snapshotSignature(f.snapshot, f.context)).toBe(before);
  });
  it('does not alias old delimiter-containing values', () => {
    const a = fixture(), b = fixture();
    a.snapshot.tasks = [{id:'a:b', startDate:'c', dueDate:'d'}];
    b.snapshot.tasks = [{id:'a', startDate:'b:c', dueDate:'d'}];
    expect(snapshotSignature(a.snapshot, a.context)).not.toBe(snapshotSignature(b.snapshot, b.context));
  });
});
