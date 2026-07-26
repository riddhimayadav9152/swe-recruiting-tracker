import type { Metadata } from 'next';
import { Space_Grotesk } from 'next/font/google';
import './globals.css';
import { Toaster } from 'react-hot-toast';

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Local SWE Recruiting Tracker',
  description: 'A local recruiting CRM for internship recruiting',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={spaceGrotesk.variable}>
      <body>
        {children}
        <Toaster position="top-right" toastOptions={{ style: { borderRadius: '14px', background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(8px)', border: '1px solid rgba(196,181,253,0.4)', color: '#3730a3', boxShadow: '0 8px 24px rgba(139,92,246,0.18)' } }} />
      </body>
    </html>
  );
}
