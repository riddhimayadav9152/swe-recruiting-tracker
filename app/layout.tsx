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
        <Toaster position="top-right" toastOptions={{ style: { borderRadius: '8px', border: '1px solid #e2e8f0', color: '#1e293b' } }} />
      </body>
    </html>
  );
}
