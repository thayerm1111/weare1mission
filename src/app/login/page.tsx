import type { Metadata, Viewport } from "next";
import { LoginExperience } from "./LoginExperience";
import { buildMetadata } from "@/lib/metadata";

export const metadata: Metadata = {
  ...buildMetadata({
    title: "Log in — One Mission",
    description: "Sign in to your One Mission trading workspace. Your intelligence, tools and connected accounts, together.",
    path: "/login",
    image: "/images/homepage/hero-poster.jpg",
  }),
  title: { absolute: "Log in — One Mission" },
  icons: { icon: { url: "/images/homepage/favicon.svg", type: "image/svg+xml" } },
};

export const viewport: Viewport = { themeColor: "#08090b" };

export default function LoginPage({ searchParams }: { searchParams: { redirect?: string | string[] } }) {
  return <LoginExperience redirect={searchParams.redirect} />;
}
