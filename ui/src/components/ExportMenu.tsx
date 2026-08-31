import type { ReactNode } from 'react';
import type { ExportKind } from '../api/index.js';
import { useApi } from '../app/api-context.js';

export function ExportMenu({ kind, id }: { kind: ExportKind; id: string }): ReactNode {
  const api = useApi();
  return (
    <details className="export-menu">
      <summary className="btn btn-quiet">Export</summary>
      <div className="export-options">
        <a href={api.exportUrl(kind, id, 'markdown')} download>
          Markdown
        </a>
        <a href={api.exportUrl(kind, id, 'json')} download>
          JSON
        </a>
        <a href={api.exportUrl(kind, id, 'bundle')} download>
          Bundle (zip)
        </a>
      </div>
    </details>
  );
}
