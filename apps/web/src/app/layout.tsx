
import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "SentinelOps AI",
    template: "%s | SentinelOps AI",
  },
  description:
    "Asistente de calidad de software basado en evidencia verificable, con investigación avanzada disponible para incidentes.",
  applicationName: "SentinelOps AI",
  openGraph: {
    title: "SentinelOps AI",
    description: "Asistente de ingeniería de software basado en evidencia verificable.",
    type: "website",
  },
  icons: { icon: "/icon.svg" },
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
