export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-charcoal/60" role="status" aria-live="polite">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-light border-t-primary" aria-hidden="true" />
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}
