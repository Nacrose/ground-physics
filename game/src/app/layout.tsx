import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stormcountry — Rain & Ground Physics Engine",
  description:
    "A playable 3D weather engine: rain, runoff, infiltration and real soil mechanics (Green-Ampt, Terzaghi, Atterberg) under your feet.",
  keywords: ["weather engine", "soil physics", "rain simulation", "three.js", "geotechnics"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
