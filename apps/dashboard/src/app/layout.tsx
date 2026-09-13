import type { ReactNode } from 'react';

import './globals.css';

export const metadata = {
  title: 'Latest in Cyber',
  description:
    'Latest in Cyber: onchain incident intelligence. The editorial dashboard for the weekly Cyberattack Sunday workflow.',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
