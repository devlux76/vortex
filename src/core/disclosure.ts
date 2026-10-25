/** Browser-safe operator rules, applied before locally authored content leaves the service. */
export type DisclosureRequest = { kind: 'announcement' | 'message'; namespace: string; network: string; text: string };
export type DisclosureCheck = (request: DisclosureRequest) => Promise<void>;
export type DisclosureConfig = { allowedNamespaces?: string[]; allowedNetworks?: string[];
  blockedPatterns?: Partial<Record<'credentials' | 'paths' | 'hostnames' | 'projects', string[]>>;
  blockedProjectIds?: string[]; requireApproval?: boolean; approvalCommand?: string };
export class DisclosureError extends Error {
  constructor(reason: string) { super('disclosure policy refused: ' + reason); }
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export function parseDisclosureConfig(value: unknown): DisclosureConfig {
  const invalid = () => { throw Error('invalid disclosure policy configuration'); };
  if (!object(value)) return invalid();
  const keys = ['allowedNamespaces', 'allowedNetworks', 'blockedPatterns', 'blockedProjectIds', 'requireApproval', 'approvalCommand'];
  if (Object.keys(value).some(key => !keys.includes(key))) invalid();
  const strings = (v: unknown) => Array.isArray(v) && v.length <= 64 && v.every(s => typeof s === 'string' && s.length > 0 && s.length <= 4096);
  for (const key of ['allowedNamespaces', 'allowedNetworks', 'blockedProjectIds'])
    if (value[key] !== undefined && !strings(value[key])) invalid();
  if (value.requireApproval !== undefined && typeof value.requireApproval !== 'boolean') invalid();
  if (value.approvalCommand !== undefined && (typeof value.approvalCommand !== 'string' || !value.approvalCommand || value.approvalCommand.length > 4096)) invalid();
  if (value.blockedPatterns !== undefined) {
    if (!object(value.blockedPatterns)) return invalid();
    for (const [category, patterns] of Object.entries(value.blockedPatterns)) {
      if (!['credentials', 'paths', 'hostnames', 'projects'].includes(category) || !strings(patterns)) invalid();
      try { for (const pattern of patterns as string[]) new RegExp(pattern, 'i'); } catch { invalid(); }
    }
  }
  return structuredClone(value) as DisclosureConfig;
}
export function createDisclosurePolicy(value: unknown, approve?: (request: DisclosureRequest) => void | Promise<void>): DisclosureCheck {
  const config = parseDisclosureConfig(value);
  const patterns = Object.entries(config.blockedPatterns ?? {}).flatMap(([category, sources]) =>
    sources.map(source => ({ category, regex: new RegExp(source, 'i') })));
  const projects = (config.blockedProjectIds ?? []).map(id => id.toLowerCase());
  return async request => {
    if (typeof request.text !== 'string') throw new DisclosureError('invalid text');
    if (config.allowedNamespaces && !config.allowedNamespaces.includes(request.namespace)) throw new DisclosureError('namespace');
    if (config.allowedNetworks && !config.allowedNetworks.includes(request.network)) throw new DisclosureError('network');
    for (const { category, regex } of patterns) if (regex.test(request.text)) throw new DisclosureError(category + ' pattern');
    if (projects.some(project => request.text.toLowerCase().includes(project))) throw new DisclosureError('project identifier');
    if (request.kind === 'announcement' && config.requireApproval) {
      if (!approve) throw new DisclosureError('operator approval unavailable');
      try { await approve({ ...request }); } catch { throw new DisclosureError('operator approval denied or unavailable'); }
    }
  };
}
