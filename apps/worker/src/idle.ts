interface SignalSource {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** none/off 模式不创建 Redis 资源，但仍作为受管进程存活到停止信号。 */
export function waitForShutdownSignal(
  source: SignalSource = process,
): Promise<'SIGINT' | 'SIGTERM'> {
  return new Promise((resolve) => {
    const finish = (signal: 'SIGINT' | 'SIGTERM'): void => {
      source.removeListener('SIGINT', onSigint);
      source.removeListener('SIGTERM', onSigterm);
      resolve(signal);
    };
    const onSigint = (): void => finish('SIGINT');
    const onSigterm = (): void => finish('SIGTERM');
    source.once('SIGINT', onSigint);
    source.once('SIGTERM', onSigterm);
  });
}
