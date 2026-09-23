import AuricDashboard from "@/components/auric/AuricDashboard";

export const metadata = { title: "AURIC — Gold automation" };
export const dynamic = "force-dynamic";

/** AURIC lives inside The Floor: the portal layout supplies the top bar and side nav; nothing navigates away. */
export default function PortalAuricPage() { return <AuricDashboard />; }
