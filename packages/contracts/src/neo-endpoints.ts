import { ENDPOINTS, type EndpointDomain, type EndpointSpec } from './endpoints';

/** Neo additions are separate from the frozen v1 parity inventory. */
export const NEO_ENDPOINT_ADDITIONS: EndpointSpec[] = [
  {
    method: 'GET',
    path: '/backup/scheduled-tasks',
    domain: 'backup',
    auth: true,
    permission: 'settings:write',
    controller: 'BackupController.scheduledTasks',
  },
];

/** Migration inventory; controller guards remain the runtime authority. */
export const NEO_ENDPOINTS: EndpointSpec[] = [
  ...ENDPOINTS,
  ...NEO_ENDPOINT_ADDITIONS,
];

export function neoEndpointsOf(domain: EndpointDomain): EndpointSpec[] {
  return NEO_ENDPOINTS.filter((endpoint) => endpoint.domain === domain);
}
