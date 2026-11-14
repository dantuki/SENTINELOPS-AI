import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { authenticatedDestination } from "@/lib/auth-redirect";
import { getAuthenticatedUser } from "@/lib/auth-page";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const parameters = await searchParams;
  const returnTo = authenticatedDestination(
    typeof parameters.returnTo === "string" ? parameters.returnTo : null,
  );
  const user = await getAuthenticatedUser();
  if (user) redirect(returnTo);
  return <LoginForm returnTo={returnTo} />;
}
