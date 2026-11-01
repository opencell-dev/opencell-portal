import { AGREEMENT } from '@/content/operator-agreement';

/** The Base Station Operator Agreement, verbatim (portal spec §6.4). */
export function AgreementText() {
  return (
    <>
      <p>
        <strong>{AGREEMENT.lead}</strong> {AGREEMENT.intro}
      </p>
      <p>{AGREEMENT.promise}</p>
      <ol className="list-decimal space-y-2 pl-6">
        {AGREEMENT.items.map(([title, text]) => (
          <li key={title}>
            <strong>{title}</strong> {text}
          </li>
        ))}
      </ol>
      <p>{AGREEMENT.closing}</p>
    </>
  );
}
