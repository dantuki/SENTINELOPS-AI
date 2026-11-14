import { AuthShell } from "@/components/auth-shell";
import { QaWorkspace } from "@/components/qa-workspace";
import { requireAuthenticatedPage } from "@/lib/auth-page";

export default async function QaPage() {
  const user = await requireAuthenticatedPage();
  return (
    <AuthShell email={user.email}>
      <QaWorkspace />
    </AuthShell>
  );
}
