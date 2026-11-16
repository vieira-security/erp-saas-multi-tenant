import type { ReactNode } from "react";
import { SessionBootstrap } from "../lib/session/session";
import "./globals.css";

export const metadata = { title: "ERP SaaS" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="antialiased">
        <SessionBootstrap />
        {children}
      </body>
    </html>
  );
}
