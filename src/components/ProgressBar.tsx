interface Props {
  percent: number;
  label?: string;
  light?: boolean;
  className?: string;
}

export function ProgressBar({ percent, label, light = false, className = "" }: Props) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className={className}>
      {label && (
        <div className={`mb-2 flex items-center justify-between text-sm font-medium ${light ? "text-light" : "text-charcoal/70"}`}>
          <span>{label}</span>
          <span className={light ? "text-white" : "text-primary"}>{clamped}%</span>
        </div>
      )}
      <div
        className={`h-2.5 w-full overflow-hidden rounded-full ${light ? "bg-white/20" : "bg-ice"}`}
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label || "Progress"}
      >
        <div
          className="h-full rounded-full bg-gradient-primary transition-[width] duration-500 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
