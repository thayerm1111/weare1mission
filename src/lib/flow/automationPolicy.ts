// Owner policy: GENX is the only automated signal source. Flow remains its
// executor/manager; existing positions from retired sources still get managed.
export function autoSourceEnabled(source: 'genx' | 'flow' | 'matty'): boolean {
  return source === 'genx';
}
export const SEND_IT_ENABLED = false;
