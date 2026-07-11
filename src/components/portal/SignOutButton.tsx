export function SignOutButton({ className = "" }: { className?: string }) {
  return (
    <form action="/auth/signout" method="post">
      <button
        type="submit"
        className={`inline-flex items-center gap-1.5 rounded-full border border-[#E4DCCB] px-4 py-2 text-sm font-semibold text-charcoal/75 hover:border-primary hover:text-primary focus-ring ${className}`}
      >
        Sign out
      </button>
    </form>
  );
}
