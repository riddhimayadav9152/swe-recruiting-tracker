import type { Metadata } from 'next';
import './globals.css';
import { Toaster } from 'react-hot-toast';

export const metadata: Metadata = {
  title: 'Local SWE Recruiting Tracker',
  description: 'A local recruiting CRM for internship recruiting',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}<Toaster position="top-right" /></body>
    </html>
  );
}
