/**
 * Node id conventions.
 *
 * Ids are stable, human-readable and derived only from *relative* paths and
 * symbol names, so a graph scanned on one machine still resolves on another
 * (and diffs cleanly in git).
 */

export const ids = {
  component: (file: string, name: string) => `component:${file}#${name}`,
  uiAction: (componentId: string, label: string) => `ui-action:${componentId}#${slug(label)}`,
  handler: (file: string, owner: string, name: string) => `handler:${file}#${owner}.${name}`,
  state: (componentId: string, name: string) => `state:${componentId}#${name}`,
  hook: (file: string, name: string) => `hook:${file}#${name}`,
  apiCall: (method: string, path: string) => `api-call:${method.toUpperCase()} ${path}`,
  route: (method: string, path: string) => `route:${method.toUpperCase()} ${path}`,
  controller: (file: string, name: string) => `controller:${file}#${name}`,
  service: (file: string, name: string) => `service:${file}#${name}`,
  method: (ownerId: string, name: string) => `method:${ownerId}.${name}`,
  dto: (name: string) => `dto:${name}`,
  model: (name: string) => `model:${name}`,
  collection: (name: string) => `collection:${name}`,
  dbOp: (collection: string, operation: string, site: string) =>
    `db-op:${collection}.${operation}@${site}`,
  field: (ownerId: string, name: string) => `field:${ownerId}#${name}`,
};

export function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
