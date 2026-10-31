/**
 * 演示时的「暂停 / 继续」开关。
 *
 * 流水线在几个检查点调用 `waitIfPaused()`：暂停时停在那里等，恢复后继续。
 * 这样观众能在「发现冲突」「算出方案」这些瞬间停下来看清楚，再往下走。
 */
export class MeetingControl {
  private paused = false;
  private waiters: Array<() => void> = [];

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }

  /** 只有在暂停状态下才会真的等待。 */
  async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
