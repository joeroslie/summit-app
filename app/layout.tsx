import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f3f5" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1115" },
  ],
};

/** Apply day/night before paint to avoid theme flash / hydration mismatch noise. */
const themeInitScript = `
(function () {
  try {
    var pref = localStorage.getItem('summitThemePref') || 'auto';
    if (pref !== 'day' && pref !== 'night' && pref !== 'auto') pref = 'auto';
    var hour = new Date().getHours();
    var mode =
      pref === 'day'
        ? 'day'
        : pref === 'night'
          ? 'night'
          : hour >= 19 || hour < 7
            ? 'night'
            : 'day';
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.style.colorScheme = mode === 'night' ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'day');
    document.documentElement.style.colorScheme = 'light';
  }
})();
`;

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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <Script
          id="summit-theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
        {children}
      </body>
    </html>
  );
}
