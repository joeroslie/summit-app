import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import ThemeInit from "@/components/ThemeInit";
import "./globals.css";

const plusJakartaSans = Plus_Jakarta_Sans({
  variable: "--font-plus-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Summit",
  description: "Summit Roofing OS",
  appleWebApp: {
    capable: true,
    title: "Summit",
    statusBarStyle: "black-translucent",
  },
  // Roofing addresses/phone numbers show up everywhere — stop iOS from
  // auto-linking them into unstyled blue tap targets.
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
  other: {
    // iOS ignored `mobile-web-app-capable` for a long time; keep both.
    "apple-mobile-web-app-capable": "yes",
  },
};

/* Pinch-zoom stays on — field use + WCAG 1.4.4. Do not lock maximumScale to 1. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  minimumScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e9eaec" },
    { media: "(prefers-color-scheme: dark)", color: "#131417" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="day"
      suppressHydrationWarning
      className={`${plusJakartaSans.variable} h-full antialiased`}
    >
      <body className={`${plusJakartaSans.className} min-h-full flex flex-col`} suppressHydrationWarning>
        <ThemeInit />
        {children}
      </body>
    </html>
  );
}
