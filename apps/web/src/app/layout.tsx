
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
