export type DotState = 'work' | 'ok' | 'bad' | 'idle';

/** A row's state at a glance. Decorative: the row's own text says the same. */
export function StateDot({ state }: { state: DotState }) {
  return <span class={`state-dot state-dot--${state}`} aria-hidden="true" />;
}
