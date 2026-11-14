import { AuthShell } from "@/components/auth-shell";
import { InvestigationWorkspace } from "@/components/investigation-workspace";
import { requireAuthenticatedPage } from "@/lib/auth-page";

export default async function InvestigationPage() {
  const user = await requireAuthenticatedPage("/investigation");
  return (
    <AuthShell email={user.email}>
      <InvestigationWorkspace />
    </AuthShell>
  );
}
