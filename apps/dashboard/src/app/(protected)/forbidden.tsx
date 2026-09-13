import Link from 'next/link';

export default function Forbidden() {
  return (
    <section>
      <h2>Forbidden</h2>
      <p>You do not have access to this.</p>
      <p>
        <Link href="/command-center">Back to the command center</Link>
      </p>
    </section>
  );
}
