"use client";

import { useMemo, useState } from "react";
import { Search, Star, Clock } from "lucide-react";
import { resources, resourceCategories } from "@/data/resources";
import { ResourceCard } from "@/components/ResourceCard";
import { EmptyState } from "@/components/EmptyState";

export function ResourcesClient() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("All");

  const categories = useMemo(
    () => ["All", ...resourceCategories.filter((c) => resources.some((r) => r.category === c))],
    []
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return resources.filter((r) => {
      const matchCat = category === "All" || r.category === category;
      const matchQuery = !q || r.title.toLowerCase().includes(q) || r.description.toLowerCase().includes(q);
      return matchCat && matchQuery;
    });
  }, [query, category]);

  const featured = resources.filter((r) => r.featured);
  const recent = resources.filter((r) => r.recentlyAdded);
  const showCurated = query.trim() === "" && category === "All";

  return (
    <div className="container-1m py-12 lg:py-16">
      {/* Search */}
      <div className="relative max-w-xl">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-charcoal/40" aria-hidden="true" />
        <label htmlFor="resource-search" className="sr-only">Search resources</label>
        <input
          id="resource-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search resources…"
          className="w-full rounded-full border border-ice bg-white py-3.5 pl-12 pr-4 text-sm shadow-card outline-none focus:border-primary"
        />
      </div>

      {/* Category filters */}
      <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Filter by category">
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            aria-pressed={category === c}
            className={`rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors focus-ring ${
              category === c ? "bg-gradient-primary text-white" : "border border-ice bg-white text-navy hover:border-primary"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Curated sections (only when not searching/filtering) */}
      {showCurated && featured.length > 0 && (
        <section className="mt-10" aria-labelledby="featured-res">
          <h2 id="featured-res" className="mb-4 flex items-center gap-2 text-lg font-bold text-navy">
            <Star className="h-5 w-5 text-primary" aria-hidden="true" /> Featured Resources
          </h2>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((r) => <ResourceCard key={r.id} r={r} />)}
          </div>
        </section>
      )}

      {showCurated && recent.length > 0 && (
        <section className="mt-10" aria-labelledby="recent-res">
          <h2 id="recent-res" className="mb-4 flex items-center gap-2 text-lg font-bold text-navy">
            <Clock className="h-5 w-5 text-primary" aria-hidden="true" /> Recently Added
          </h2>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {recent.map((r) => <ResourceCard key={r.id} r={r} />)}
          </div>
        </section>
      )}

      {/* All / filtered results */}
      <section className="mt-10" aria-labelledby="all-res">
        <h2 id="all-res" className="mb-4 text-lg font-bold text-navy">
          {showCurated ? "All Resources" : `${filtered.length} result${filtered.length === 1 ? "" : "s"}`}
        </h2>
        {filtered.length === 0 ? (
          <EmptyState message="No resources match your search. Try another term or category." />
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((r) => <ResourceCard key={r.id} r={r} />)}
          </div>
        )}
      </section>
    </div>
  );
}
