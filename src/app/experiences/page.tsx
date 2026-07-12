import { StorePage } from "@/components/shop/StorePage";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "1M Experiences",
  description: "Live events, retreats, and gatherings for the 1 Mission community. Reserve your spot and pay securely.",
  path: "/experiences",
});

export const revalidate = 300;

export default function ExperiencesPage() {
  return (
    <StorePage
      handle="1m-experiences"
      eyebrow="1M Experiences"
      title="Where the movement gathers"
      description="Live events, retreats, and experiences with the 1 Mission community. Reserve your spot and pay securely."
    />
  );
}
