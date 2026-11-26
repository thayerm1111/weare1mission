import "./workspace-loading.css";

export default function PortalLoading() {
  return <section className="om-workspace-loading" role="status" aria-busy="true">
    <p>Opening workspace…</p>
    <div className="om-loading-lines" aria-hidden="true"><i /><i /></div>
    <div className="om-loading-panels" aria-hidden="true"><i /><i /></div>
  </section>;
}
