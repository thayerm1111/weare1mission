/**
 * Origin — the emotional heart of the page. A quiet, universal nod to the
 * parable of the one: ninety-nine were accounted for; this is for the one
 * still searching. Kept spiritual-but-subtle per brand direction (the feeling,
 * not the sermon). Full-black for gravity.
 */
export function Origin() {
  return (
    <section id="the-one" className="relative overflow-hidden bg-navy">
      <div className="container-1m py-24 text-center sm:py-28 lg:py-36">
        <span className="eyebrow justify-center text-gold-light">The One</span>

        <h2 className="mx-auto mt-7 max-w-4xl font-serif text-[clamp(2rem,6.2vw,4.25rem)] font-semibold uppercase leading-[1.02] tracking-[0.01em] text-white">
          Ninety-nine were
          <br />
          accounted for.
          <br />
          <span className="text-gold-light">This is for the one.</span>
        </h2>

        <div className="mx-auto mt-10 max-w-xl space-y-5 text-lg leading-relaxed text-light/80">
          <p>
            The one is everyone still searching — praying, grinding, holding on
            to the belief that there has to be more than the life they were handed.
          </p>
          <p>
            If you&apos;ve ever felt unseen while chasing something bigger, you
            already understand. One Mission was built to go find you.
          </p>
        </div>

        <p className="mx-auto mt-12 max-w-md font-serif text-xs uppercase tracking-[0.3em] text-white/45">
          You&apos;re not behind. You&apos;re early. And you&apos;re home.
        </p>
      </div>
    </section>
  );
}
