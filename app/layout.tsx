import type { Metadata } from "next";
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
