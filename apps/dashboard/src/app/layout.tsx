import type { ReactNode } from 'react';

import './globals.css';

export const metadata = {
  title: 'CAS Chainwatch dashboard',
  description: 'Cyberattack Sunday: Onchain Incident Intelligence. Editorial dashboard.',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
