import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StockLens Inventory Tools",
  description: "Item lookup and inventory pull tools for WOH inventory.",
  other: { "codex-preview": "development" },
  openGraph: {
    title: "StockLens Inventory Tools",
    description: "Look up items and create inventory-pull CSV files by scanning barcodes.",
    images: ["/og.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "StockLens Inventory Tools",
    description: "Look up items and create inventory-pull CSV files by scanning barcodes.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
