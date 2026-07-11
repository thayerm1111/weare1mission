import { ImageIcon } from "lucide-react";

/**
 * PlaceholderImage — shows a branded placeholder box.
 * When you have a real image, place it in /public/images and reference it
 * with a normal <img> or next/image in the relevant component/data file.
 */
interface Props {
  label?: string;
  aspect?: "video" | "square" | "portrait" | "wide";
  className?: string;
  rounded?: string;
}

const aspects: Record<string, string> = {
  video: "aspect-video",
  square: "aspect-square",
  portrait: "aspect-[3/4]",
  wide: "aspect-[16/7]",
};

export function PlaceholderImage({
  label = "Image placeholder",
  aspect = "video",
  className = "",
  rounded = "rounded-xl",
}: Props) {
  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden ${rounded} ${aspects[aspect]} bg-gradient-to-br from-ice via-light/40 to-white ${className}`}
      role="img"
      aria-label={label}
    >
      <div className="flex flex-col items-center text-medium/70">
        <ImageIcon className="h-8 w-8" aria-hidden="true" />
        <span className="mt-2 px-3 text-center text-xs font-medium">{label}</span>
      </div>
    </div>
  );
}
