import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
/** AURIC moved inside The Floor; old links keep working. */
export default function AuricPage() { redirect("/portal/auric"); }
