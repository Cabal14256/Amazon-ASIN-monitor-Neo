import {
  monitorIdentity,
  parseMonitorNotice,
  validMonitorProof,
  type MonitorNotice,
  type RedisMonitorEventRepository,
} from '@asin-monitor/db';
import type { WebSocketEvent } from './websocket-events';

/** Pub/Sub contains a small hint; only a budgeted stored proof plus a current
 * task read can produce an authenticated broadcast. Historical hints are not
 * replayed on reconnect: HTTP/history are the recovery sources. */
export class MonitorNotificationConsumer {
  private readonly pending = new Map<string, MonitorNotice>();
  private readonly active = new Set<string>();
  private readonly seen = new Map<string, number>();
  private readonly phases = new Map<string, 'progress' | 'complete'>();
  private generation = 0;
  private stopped = false;
  constructor(
    private readonly read: RedisMonitorEventRepository['read'],
    private readonly deliver: (event: WebSocketEvent) => void,
    private readonly warn: (reason: string) => void,
  ) {}
  receive(raw: string): void {
    if (this.stopped) return;
    const notice = parseMonitorNotice(raw);
    if (!notice) {
      this.warn('invalid_monitor_notification');
      return;
    }
    const key = `${monitorIdentity(notice)}:${notice.slot}`;
    if (
      (this.seen.get(key) ?? -1) >= notice.sequence ||
      (this.pending.get(key)?.sequence ?? -1) >= notice.sequence
    )
      return;
    if (!this.pending.has(key) && this.pending.size >= 256) {
      this.warn('monitor_notification_overload');
      return;
    }
    this.pending.set(key, notice);
    this.pump();
  }
  private pump() {
    if (this.stopped) return;
    for (const [key, notice] of this.pending) {
      if (this.active.size >= 8) break;
      if (this.active.has(key)) continue;
      this.pending.delete(key);
      if ((this.seen.get(key) ?? -1) >= notice.sequence) continue;
      this.active.add(key);
      const generation = this.generation;
      void this.process(key, notice, generation).finally(() => {
        this.active.delete(key);
        this.pump();
      });
    }
  }
  private async process(
    key: string,
    notice: MonitorNotice,
    generation: number,
  ) {
    try {
      const value = await this.read(notice);
      if (
        this.stopped ||
        generation !== this.generation ||
        !value ||
        monitorIdentity(value.proof.notice) !== monitorIdentity(notice) ||
        value.proof.notice.slot !== notice.slot ||
        value.proof.notice.sequence !== notice.sequence ||
        value.proof.notice.revision !== notice.revision ||
        !validMonitorProof(value.task, value.proof) ||
        (this.seen.get(key) ?? -1) >= notice.sequence
      )
        return;
      const identity = monitorIdentity(notice),
        message = value.proof.message,
        phase = this.phases.get(identity);
      if (
        message.type === 'monitor_progress' &&
        (phase === 'complete' ||
          (message.status === 'started' && phase === 'progress'))
      )
        return;
      this.deliver({ audience: 'all', message: value.proof.message });
      if (
        message.type === 'monitor_complete' ||
        message.status === 'progress'
      ) {
        this.phases.delete(identity);
        this.phases.set(
          identity,
          message.type === 'monitor_complete' ? 'complete' : 'progress',
        );
        if (this.phases.size > 4096) {
          // Pin phases while any slot is in flight, preventing a delayed
          // authoritative read from regressing an already delivered terminal.
          for (const candidate of this.phases.keys()) {
            if (
              ![...this.active].some((active) =>
                active.startsWith(`${candidate}:`),
              )
            ) {
              this.phases.delete(candidate);
              break;
            }
          }
        }
      }
      this.seen.delete(key);
      this.seen.set(key, notice.sequence);
      if (this.seen.size > 4096)
        this.seen.delete(this.seen.keys().next().value!);
    } catch {
      this.warn('monitor_notification_read_failed');
    }
  }
  disconnected() {
    this.generation++;
    this.pending.clear();
  }
  stop() {
    this.stopped = true;
    this.disconnected();
    this.seen.clear();
    this.phases.clear();
  }
}
