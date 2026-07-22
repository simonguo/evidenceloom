export function ErrorList({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return <div className="rounded-lg border border-rose-300/30 bg-rose-500/10 p-4 text-sm text-rose-100 md:col-span-2">{errors.map((error) => <div key={error}>{error}</div>)}</div>;
}
