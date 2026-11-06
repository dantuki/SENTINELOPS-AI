import { AuthShell } from "@/components/auth-shell";
import { KnowledgeBase } from "@/components/knowledge-base";
import { requireAuthenticatedPage } from "@/lib/auth-page";

export default async function KnowledgeBasePage() {
  const user = await requireAuthenticatedPage();
  return (
    <AuthShell email={user.email}>
      <KnowledgeBase />
    </AuthShell>
  );
}
