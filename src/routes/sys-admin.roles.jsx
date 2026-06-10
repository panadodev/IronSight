import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/sys-admin/roles")({
  head: () => ({ meta: [{ title: "Redirecting..." }] }),
  component: RedirectPage,
});

function RedirectPage() {
  useEffect(() => {
    // This route has been removed. Role management is now available per-org for org owners.
    // Redirect to manage section
    window.location.assign("/manage");
  }, []);

  return (
    <div className="h-screen w-full flex items-center justify-center bg-background">
      <div className="text-center">
        <h1 className="text-xl font-semibold mb-2">Redirecting...</h1>
        <p className="text-sm text-muted-foreground">
          Role management has been moved to organization settings.
        </p>
      </div>
    </div>
  );
}
