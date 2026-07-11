import { PlayCircle } from "lucide-react";

interface Props {
  url?: string;
  title?: string;
}

/** Renders a responsive 16:9 video, or a labeled placeholder when no URL is set. */
export function VideoEmbed({ url, title = "Video" }: Props) {
  if (!url) {
    return (
      <div className="flex aspect-video w-full flex-col items-center justify-center rounded-xl border border-dashed border-light bg-ice/60 text-center">
        <PlayCircle className="h-10 w-10 text-medium" aria-hidden="true" />
        <p className="mt-2 text-sm font-medium text-navy">Video placeholder</p>
        <p className="mt-1 text-xs text-charcoal/60">Add an embed URL in the data file</p>
      </div>
    );
  }
  return (
    <div className="aspect-video w-full overflow-hidden rounded-xl bg-navy shadow-card">
      <iframe
        src={url}
        title={title}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className="h-full w-full"
      />
    </div>
  );
}
