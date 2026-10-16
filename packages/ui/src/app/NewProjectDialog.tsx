import type { ProjectInfo } from '@vesper/protocol';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.js';
import { FolderPicker } from './FolderPicker.js';

interface Props {
  onClose: () => void;
  onCreated: (project: ProjectInfo) => void;
}

/** A project is a new folder under the default root, or an existing folder picked on the server. */
export function NewProjectDialog({ onClose, onCreated }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const create = async (body: { name: string; path?: string }) => {
    setError('');
    try {
      onCreated((await api<{ project: ProjectInfo }>('POST', '/api/projects', body)).project);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : '创建失败');
    }
  };

  const submitNew = (event: FormEvent) => {
    event.preventDefault();
    void create({ name });
  };

  const pickExisting = (path: string) => {
    const folder = path.replace(/\\+$/, '').split('\\').at(-1) || path;
    void create({ name: name.trim() || folder, path });
  };

  return (
    <dialog ref={dialog} className="dialog" onClose={onClose} aria-labelledby="new-project-title">
      <h2 id="new-project-title">新建项目</h2>
      <div className="segmented" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'new'} onClick={() => setMode('new')}>
          新文件夹
        </button>
        <button type="button" role="tab" aria-selected={mode === 'existing'} onClick={() => setMode('existing')}>
          已有文件夹
        </button>
      </div>
      <form onSubmit={submitNew}>
        <label htmlFor="project-name">名字{mode === 'existing' && '（留空用文件夹名）'}</label>
        <input id="project-name" value={name} autoFocus onChange={(event) => setName(event.target.value)} />
        {mode === 'new' && (
          <button type="submit" className="primary" disabled={name.trim() === ''}>
            创建
          </button>
        )}
      </form>
      {mode === 'existing' && <FolderPicker onPick={pickExisting} />}
      <p className="error" role="alert">
        {error}
      </p>
      <button type="button" onClick={() => dialog.current?.close()}>
        取消
      </button>
    </dialog>
  );
}
