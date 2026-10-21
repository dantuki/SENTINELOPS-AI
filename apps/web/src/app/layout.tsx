
import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "SentinelOps AI",
    template: "%s | SentinelOps AI",
  },
  description:
    "Plataforma de investigación de incidentes de software basada en evidencias, RAG y herramientas MCP.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
