import type { FolderListing } from '@vesper/protocol';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';

interface Props {
  onPick: (path: string) => void;
}

/** Browses the server's local drives; picking a folder uses the one being shown. */
export function FolderPicker({ onPick }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [listing, setListing] = useState<FolderListing>();
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    setError('');
    api<FolderListing>('GET', path === null ? '/api/folders' : `/api/folders?path=${encodeURIComponent(path)}`).then(
      (result) => current && setListing(result),
      (failure: unknown) => current && setError(failure instanceof ApiError ? failure.message : '读取失败'),
    );
    return () => {
      current = false;
    };
  }, [path]);

  return (
    <div className="folder-picker">
      <div className="folder-path">
        <button type="button" onClick={() => setPath(listing?.parent ?? null)} disabled={path === null} aria-label="上一级">
          ↑
        </button>
        <span className="mono">{listing?.path ?? '此电脑'}</span>
      </div>
      <ul className="folder-list" role="listbox" aria-label="文件夹">
        {listing?.folders.map((folder) => (
          <li key={folder.path}>
            <button type="button" className="folder" onClick={() => setPath(folder.path)}>
              {folder.name}
            </button>
          </li>
        ))}
        {listing?.truncated && <li className="muted">文件夹太多，只显示前一部分</li>}
      </ul>
      <p className="error" role="alert">
        {error}
      </p>
      <button type="button" className="primary" disabled={!listing?.path} onClick={() => listing?.path && onPick(listing.path)}>
        选择这个文件夹
      </button>
    </div>
  );
}
