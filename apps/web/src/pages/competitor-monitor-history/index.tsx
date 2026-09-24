import { HistoryBrowser } from '../monitor-history/history-browser';
import { HISTORY_SOURCES } from '../monitor-history/history-sources';

export default function CompetitorMonitorHistoryPage() {
  return <HistoryBrowser source={HISTORY_SOURCES.competitor} />;
}
