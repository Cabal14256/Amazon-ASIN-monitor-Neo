import { HistoryBrowser } from './history-browser';
import { HISTORY_SOURCES } from './history-sources';

export default function MonitorHistoryPage() {
  return <HistoryBrowser source={HISTORY_SOURCES.primary} />;
}
