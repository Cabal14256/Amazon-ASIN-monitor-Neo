// Compatibility export: API and Worker share one pure queue catalog.
export {
  QUEUE_DEFINITIONS,
  QUEUE_NAMES,
  getPhysicalQueueName,
  resolveEnabledQueues,
  resolveQueueSelection,
  shouldInitializeQueueRuntime,
  type QueueName,
  type QueueSelection,
} from '@asin-monitor/config';
