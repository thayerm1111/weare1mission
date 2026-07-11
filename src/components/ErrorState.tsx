import { AlertCircle } from "lucide-react";

interface Props {
  title?: string;
  message?: string;
}

export function ErrorState({
  title = "Something went wrong",
  message = "Please refresh the page or try again in a moment.",
}: Props) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-red-200 bg-red-50 px-6 py-12 text-center" role="alert">
      <AlertCircle className="h-8 w-8 text-red-500" aria-hidden="true" />
      <h3 className="mt-3 text-lg font-semibold text-red-900">{title}</h3>
      <p className="mt-1 text-sm text-red-700">{message}</p>
    </div>
  );
}
